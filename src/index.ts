import { LRUCache } from "lru-cache";
import dns from "node:dns";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[] | undefined,
  family?: number
) => void;

type LookupFunction = {
  (hostname: string, callback: LookupCallback): void;
  (
    hostname: string,
    options: dns.LookupOptions,
    callback: LookupCallback
  ): void;
  (
    hostname: string,
    options: dns.LookupOneOptions,
    callback: LookupCallback
  ): void;
  (
    hostname: string,
    options: dns.LookupAllOptions,
    callback: LookupCallback
  ): void;
  (
    hostname: string,
    options: dns.LookupOptions | dns.LookupOneOptions | dns.LookupAllOptions,
    callback: LookupCallback
  ): void;
  __promisify__: typeof dns.lookup.__promisify__;
} & typeof dns.lookup;

export interface DnsCache {
  addresses: { ipv4: string[]; ipv6: string[] };
  activeAddress: string;
  family: number;
  timestamp: number;
  ttl: number;
  hits: number;
  misses: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  failures: number;
  ipv4Fallbacks: number;
}

export interface Logger {
  debug: (message: string, meta?: Record<string, any>) => void;
  error: (message: string, meta?: Record<string, any>) => void;
}

export type DnsEntry = {
  addresses: { ipv4: number; ipv6: number };
  activeAddress: string;
  family: number;
  age: number;
  ttl: number;
  hits: number;
  misses: number;
};

export type DnsEntries = Record<string, DnsEntry>;

export interface DnsStats {
  size: number;
  cacheMaxEntries: number;
  hits: number;
  misses: number;
  failures: number;
  ipv4Fallbacks: number;
  hitRate: number;
}

export interface DnsCacheManagerOptions {
  cacheMaxEntries?: number;
  forceMaxTtl?: number;
  forceMinTtl?: number;
  maxRetries?: number;
  logger?: Logger;
}

export class DnsCacheManager {
  private cache: LRUCache<string, DnsCache>;
  private resolver: dns.promises.Resolver;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    failures: 0,
    ipv4Fallbacks: 0,
  };
  private forceMaxTtl: number;
  private forceMinTtl: number;
  private maxRetries: number;
  private originalDnsLookup: typeof dns.lookup;
  private originalPromisify: typeof dns.lookup.__promisify__;
  private logger: Logger;

  constructor({
    cacheMaxEntries = 500,
    forceMaxTtl = -1,
    forceMinTtl = 0,
    maxRetries = 3,
    logger = console,
  }: DnsCacheManagerOptions = {}) {
    this.originalDnsLookup = dns.lookup;
    this.originalPromisify = this.originalDnsLookup.__promisify__;

    this.cache = new LRUCache<string, DnsCache>({
      max: cacheMaxEntries,
      ttl: forceMaxTtl > 0 ? forceMaxTtl : undefined,
    });
    this.forceMaxTtl = forceMaxTtl;
    this.forceMinTtl = forceMinTtl > 0 ? forceMinTtl : 0;
    this.resolver = new dns.promises.Resolver();
    this.maxRetries = maxRetries;

    this.logger = logger;
  }

  public initialize(): void {
    const wrappedLookup = ((
      hostname: string,
      options:
        | number
        | dns.LookupOneOptions
        | dns.LookupOptions
        | dns.LookupAllOptions,
      callback: LookupCallback
    ): void => {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }

      const opts =
        typeof options === "number"
          ? ({ family: options } as dns.LookupOptions)
          : options || ({} as dns.LookupOptions | dns.LookupAllOptions);

      const reqFamily =
        typeof (opts as dns.LookupOptions).family === "number"
          ? (opts as dns.LookupOptions).family
          : 0;

      const reqAll = (opts as dns.LookupAllOptions).all === true;

      const forceIpv4 = reqFamily === 4;

      this.lookup(hostname, 0, forceIpv4)
        .catch((error) => {
          this.logger.debug(
            `Cached DNS lookup failed for ${hostname}, falling back to native DNS: ${error.message}`,
            {
              label: "DNSCache",
            }
          );

          try {
            this.originalDnsLookup(
              hostname,
              options as any,
              (err, addr, fam) => {
                if (!err && addr) {
                  const cacheEntry = {
                    addresses: {
                      ipv4: Array.isArray(addr)
                        ? addr
                            .filter((a) => a.family === 4)
                            .map((a) => a.address)
                        : typeof addr === "string" && !addr.includes(":")
                        ? [addr]
                        : [],
                      ipv6: Array.isArray(addr)
                        ? addr
                            .filter((a) => a.family === 6)
                            .map((a) => a.address)
                        : typeof addr === "string" && addr.includes(":")
                        ? [addr]
                        : [],
                    },
                    activeAddress: Array.isArray(addr)
                      ? addr[0]?.address || ""
                      : (addr as string),
                    family: Array.isArray(addr)
                      ? addr[0]?.family || 4
                      : fam || 4,
                    timestamp: Date.now(),
                    ttl: Math.min(
                      Math.max(this.forceMinTtl, 60000),
                      this.forceMaxTtl
                    ),
                    hits: 0,
                    misses: 0,
                  };

                  this.updateCache(hostname, cacheEntry).catch(() => {
                    this.logger.debug(
                      `Failed to update DNS cache for ${hostname}: ${error.message}`,
                      {
                        label: "DNSCache",
                      }
                    );
                  });
                }
                callback(err, addr, fam);
              }
            );
            return;
          } catch (fallbackError) {
            this.logger.error(
              `Native DNS fallback also failed for ${hostname}: ${
                fallbackError instanceof Error
                  ? fallbackError.message
                  : fallbackError
              }`,
              {
                label: "DNSCache",
              }
            );
          }

          callback(error, undefined, undefined);
        })
        .then((result) => {
          if (!result) return;

          if (reqAll) {
            const allAddresses: dns.LookupAddress[] = [
              ...result.addresses.ipv4.map((addr) => ({
                address: addr,
                family: 4 as const,
              })),
              ...result.addresses.ipv6.map((addr) => ({
                address: addr,
                family: 6 as const,
              })),
            ];

            // keep current fallback behavior if no addresses found
            callback(
              null,
              allAddresses.length > 0
                ? allAddresses
                : [{ address: result.activeAddress, family: result.family }]
            );
            return;
          }

          // if a specific family is requested but no addresses of that family are found, return ENOTFOUND
          // similar to native node.js dns.lookup behavior
          if (reqFamily === 4 && result.addresses.ipv4.length === 0) {
            const err = Object.assign(new Error(`ENOTFOUND ${hostname}`), {
              code: "ENOTFOUND",
            });
            callback(err, undefined, undefined);
            return;
          }
          if (reqFamily === 6 && result.addresses.ipv6.length === 0) {
            const err = Object.assign(new Error(`ENOTFOUND ${hostname}`), {
              code: "ENOTFOUND",
            });
            callback(err, undefined, undefined);
            return;
          }

          // otherwise return the active address
          callback(null, result.activeAddress, result.family);
        });
    }) as LookupFunction;

    (wrappedLookup as any).__promisify__ = async (
      hostname: string,
      options?:
        | dns.LookupAllOptions
        | dns.LookupOneOptions
        | number
        | dns.LookupOptions
    ): Promise<dns.LookupAddress[] | { address: string; family: number }> => {
      const opts =
        typeof options === "number"
          ? ({ family: options } as dns.LookupOptions)
          : ((options || {}) as dns.LookupOptions | dns.LookupAllOptions);

      const reqFamily =
        typeof (opts as dns.LookupOptions).family === "number"
          ? (opts as dns.LookupOptions).family
          : 0;
      const reqAll = (opts as dns.LookupAllOptions).all === true;

      try {
        const result = await this.lookup(hostname, 0, reqFamily === 4);

        // same behavior as above callback version
        if (reqAll) {
          const allAddresses: dns.LookupAddress[] = [
            ...result.addresses.ipv4.map((addr) => ({
              address: addr,
              family: 4 as const,
            })),
            ...result.addresses.ipv6.map((addr) => ({
              address: addr,
              family: 6 as const,
            })),
          ];
          return allAddresses.length > 0
            ? allAddresses
            : [{ address: result.activeAddress, family: result.family }];
        }

        if (reqFamily === 4 && result.addresses.ipv4.length === 0) {
          const err = Object.assign(new Error(`ENOTFOUND ${hostname}`), {
            code: "ENOTFOUND",
          });
          throw err;
        }
        if (reqFamily === 6 && result.addresses.ipv6.length === 0) {
          const err = Object.assign(new Error(`ENOTFOUND ${hostname}`), {
            code: "ENOTFOUND",
          });
          throw err;
        }

        return { address: result.activeAddress, family: result.family };
      } catch (error) {
        if (this.originalPromisify) {
          const nativeResult = await this.originalPromisify(
            hostname,
            options as any
          );
          return nativeResult;
        }
        throw error;
      }
    };

    dns.lookup = wrappedLookup;
    dns.promises.lookup = wrappedLookup.__promisify__;
  }

  async lookup(
    hostname: string,
    retryCount = 0,
    forceIpv4 = false
  ): Promise<DnsCache> {
    if (hostname === "localhost") {
      return {
        addresses: {
          ipv4: ["127.0.0.1"],
          ipv6: ["::1"],
        },
        activeAddress: "127.0.0.1",
        family: 4,
        timestamp: Date.now(),
        ttl: 0,
        hits: 0,
        misses: 0,
      };
    } else if (hostname === "::1") {
      return {
        addresses: {
          ipv4: [],
          ipv6: ["::1"],
        },
        activeAddress: "::1",
        family: 6,
        timestamp: Date.now(),
        ttl: 0,
        hits: 0,
        misses: 0,
      };
    }

    // force ipv4 if configured
    const shouldForceIpv4 = forceIpv4;

    const cached = this.cache.get(hostname);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      const ttlRemaining = Math.max(0, cached.ttl - age);

      if (ttlRemaining > 0) {
        if (
          shouldForceIpv4 &&
          cached.family === 6 &&
          cached.addresses.ipv4.length > 0
        ) {
          const ipv4Address = cached.addresses.ipv4[0];
          this.logger.debug(`Switching from IPv6 to IPv4 for ${hostname}`, {
            label: "DNSCache",
            oldAddress: cached.activeAddress,
            newAddress: ipv4Address,
          });

          this.stats.ipv4Fallbacks++;
          return {
            ...cached,
            activeAddress: ipv4Address,
            family: 4,
          };
        }

        cached.hits++;
        this.stats.hits++;
        return cached;
      }

      // Soft expiration. Will use stale entry while refreshing
      if (this.forceMaxTtl > 0 && age < this.forceMaxTtl) {
        cached.misses++;
        this.stats.misses++;

        // Background refresh
        this.resolveWithTtl(hostname)
          .then((result) => {
            const preferredFamily = shouldForceIpv4 ? 4 : 6;

            const activeAddress = this.selectActiveAddress(
              result.addresses,
              preferredFamily
            );
            const family = activeAddress.includes(":") ? 6 : 4;

            const existing = this.cache.get(hostname);
            this.cache.set(hostname, {
              addresses: result.addresses,
              activeAddress,
              family,
              timestamp: Date.now(),
              ttl: Math.max(this.forceMinTtl, result.ttl),
              hits: existing?.hits ?? 0,
              misses: (existing?.misses ?? 0) + 1,
            });
          })
          .catch((error) => {
            this.logger.error(
              `Failed to refresh DNS for ${hostname}: ${error.message}`
            );
          });

        return cached;
      }

      // Hard expiration to remove stale entry
      this.stats.misses++;
      this.cache.delete(hostname);
    }

    try {
      const result = await this.resolveWithTtl(hostname);

      const preferredFamily = shouldForceIpv4 ? 4 : 6;

      const activeAddress = this.selectActiveAddress(
        result.addresses,
        preferredFamily
      );
      const family = activeAddress.includes(":") ? 6 : 4;

      const existingMisses = this.cache.get(hostname)?.misses ?? 0;

      const dnsCache: DnsCache = {
        addresses: result.addresses,
        activeAddress,
        family,
        timestamp: Date.now(),
        ttl: Math.max(this.forceMinTtl, result.ttl),
        hits: 0,
        misses: existingMisses + 1,
      };

      this.cache.set(hostname, dnsCache);

      return dnsCache;
    } catch (error) {
      this.stats.failures++;

      if (retryCount < this.maxRetries) {
        const backoff = Math.min(100 * Math.pow(2, retryCount), 2000);
        this.logger.debug(
          `DNS lookup failed for ${hostname}, retrying (${retryCount + 1}/${
            this.maxRetries
          }) after ${backoff}ms`,
          {
            label: "DNSCache",
            error: error instanceof Error ? error.message : error,
          }
        );

        await new Promise((resolve) => setTimeout(resolve, backoff));

        // If this is the last retry and was using IPv6 then force IPv4
        const shouldTryIpv4 = retryCount === this.maxRetries - 1 && !forceIpv4;

        return this.lookup(hostname, retryCount + 1, shouldTryIpv4);
      } else {
        this.logger.debug(
          `DNS lookup failed for ${hostname} after ${this.maxRetries} retries`,
          {
            label: "DNSCache",
          }
        );
      }

      // If there is a stale entry, use it as last resort
      const staleEntry = this.getStaleEntry(hostname);
      if (staleEntry) {
        this.logger.debug(
          `Using expired DNS cache as fallback for ${hostname} after ${this.maxRetries} failed lookups`,
          {
            label: "DNSCache",
            activeAddress: staleEntry.activeAddress,
          }
        );

        // If we want to force IPv4 and IPv4 addresses are available, use those instead
        if (
          shouldForceIpv4 &&
          staleEntry.family === 6 &&
          staleEntry.addresses.ipv4.length > 0
        ) {
          this.stats.ipv4Fallbacks++;
          const ipv4Address = staleEntry.addresses.ipv4[0];
          this.logger.debug(
            `Switching expired cache from IPv6 to IPv4 for ${hostname} in test mode`,
            {
              label: "DNSCache",
              oldAddress: staleEntry.activeAddress,
              newAddress: ipv4Address,
            }
          );

          return {
            ...staleEntry,
            activeAddress: ipv4Address,
            family: 4,
            timestamp: Date.now(),
            ttl: Math.min(
              Math.max(this.forceMinTtl, staleEntry.ttl || 60000),
              this.forceMaxTtl
            ),
          };
        }

        return {
          ...staleEntry,
          timestamp: Date.now(),
          ttl: Math.min(
            Math.max(this.forceMinTtl, staleEntry.ttl || 60000),
            this.forceMaxTtl
          ),
        };
      }

      throw new Error(
        `DNS lookup failed for ${hostname} after ${this.maxRetries} retries: ${
          error instanceof Error ? error.message : error
        }`
      );
    }
  }

  private selectActiveAddress(
    addresses: { ipv4: string[]; ipv6: string[] },
    preferredFamily: number
  ): string {
    if (preferredFamily === 4) {
      return addresses.ipv4.length > 0
        ? addresses.ipv4[0]
        : addresses.ipv6.length > 0
        ? addresses.ipv6[0]
        : "127.0.0.1";
    } else {
      return addresses.ipv6.length > 0
        ? addresses.ipv6[0]
        : addresses.ipv4.length > 0
        ? addresses.ipv4[0]
        : "127.0.0.1";
    }
  }

  private getStaleEntry(hostname: string): DnsCache | null {
    const entry = this.cache.get(hostname);
    if (entry) {
      if (!entry.addresses && entry.activeAddress) {
        return {
          addresses: {
            ipv4: entry.family === 4 ? [entry.activeAddress] : [],
            ipv6: entry.family === 6 ? [entry.activeAddress] : [],
          },
          activeAddress: entry.activeAddress,
          family: entry.family,
          timestamp: entry.timestamp,
          ttl: entry.ttl,
          hits: entry.hits,
          misses: entry.misses,
        };
      }
      return entry;
    }
    return null;
  }
  private async resolveWithTtl(
    hostname: string
  ): Promise<{ addresses: { ipv4: string[]; ipv6: string[] }; ttl: number }> {
    if (
      !this.resolver ||
      typeof this.resolver.resolve4 !== "function" ||
      typeof this.resolver.resolve6 !== "function"
    ) {
      throw new Error("Resolver is not initialized");
    }

    try {
      const [ipv4Records, ipv6Records] = await Promise.allSettled([
        this.resolver.resolve4(hostname, { ttl: true }),
        this.resolver.resolve6(hostname, { ttl: true }),
      ]);

      const addresses = {
        ipv4: [] as string[],
        ipv6: [] as string[],
      };

      let minTtl = Infinity;

      if (ipv4Records.status === "fulfilled" && ipv4Records.value.length > 0) {
        addresses.ipv4 = ipv4Records.value.map((record) => record.address);

        // Find minimum TTL from IPv4 records
        const ipv4TtlValues = ipv4Records.value
          .map((r) => r.ttl)
          .filter((ttl): ttl is number => ttl !== undefined);

        if (ipv4TtlValues.length > 0) {
          const ipv4MinTtl = Math.min(...ipv4TtlValues);
          if (ipv4MinTtl < minTtl) {
            minTtl = ipv4MinTtl;
          }
        }
      }

      if (ipv6Records.status === "fulfilled" && ipv6Records.value.length > 0) {
        addresses.ipv6 = ipv6Records.value.map((record) => record.address);

        // Find minimum TTL from IPv6 records
        const ipv6TtlValues = ipv6Records.value
          .map((r) => r.ttl)
          .filter((ttl): ttl is number => ttl !== undefined);

        if (ipv6TtlValues.length > 0) {
          const ipv6MinTtl = Math.min(...ipv6TtlValues);
          if (ipv6MinTtl < minTtl) {
            minTtl = ipv6MinTtl;
          }
        }
      }

      if (addresses.ipv4.length === 0 && addresses.ipv6.length === 0) {
        throw new Error(`No DNS records found for ${hostname}`);
      }

      // If no TTL was found, use a sensible default
      if (minTtl === Infinity) {
        minTtl = 300; // Default to 300 seconds if no TTL returned
      }

      const ttlMs = minTtl * 1000;

      return { addresses, ttl: ttlMs };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Updates the cache with an externally provided entry
   * Used for updating cache from fallback DNS lookups
   */
  async updateCache(hostname: string, entry: DnsCache): Promise<void> {
    if (!entry || !entry.activeAddress || !entry.addresses) {
      throw new Error("Invalid cache entry provided");
    }

    const validatedEntry: DnsCache = {
      addresses: {
        ipv4: Array.isArray(entry.addresses.ipv4) ? entry.addresses.ipv4 : [],
        ipv6: Array.isArray(entry.addresses.ipv6) ? entry.addresses.ipv6 : [],
      },
      activeAddress: entry.activeAddress,
      family: entry.family || (entry.activeAddress.includes(":") ? 6 : 4),
      timestamp: entry.timestamp || Date.now(),
      ttl: Math.max(this.forceMinTtl, entry.ttl),
      hits: entry.hits || 0,
      misses: entry.misses || 0,
    };

    if (
      validatedEntry.addresses.ipv4.length === 0 &&
      validatedEntry.addresses.ipv6.length === 0
    ) {
      if (validatedEntry.activeAddress.includes(":")) {
        validatedEntry.addresses.ipv6.push(validatedEntry.activeAddress);
      } else {
        validatedEntry.addresses.ipv4.push(validatedEntry.activeAddress);
      }
    }

    const existing = this.cache.get(hostname);
    if (existing) {
      const mergedEntry: DnsCache = {
        addresses: {
          ipv4: [
            ...new Set([
              ...existing.addresses.ipv4,
              ...validatedEntry.addresses.ipv4,
            ]),
          ],
          ipv6: [
            ...new Set([
              ...existing.addresses.ipv6,
              ...validatedEntry.addresses.ipv6,
            ]),
          ],
        },
        activeAddress: validatedEntry.activeAddress,
        family: validatedEntry.family,
        timestamp: validatedEntry.timestamp,
        ttl: validatedEntry.ttl,
        hits: 0,
        misses: 0,
      };

      this.cache.set(hostname, mergedEntry);
      this.logger.debug(`Updated DNS cache for ${hostname} with merged entry`, {
        label: "DNSCache",
        addresses: {
          ipv4: mergedEntry.addresses.ipv4.length,
          ipv6: mergedEntry.addresses.ipv6.length,
        },
        activeAddress: mergedEntry.activeAddress,
        family: mergedEntry.family,
      });
    } else {
      this.cache.set(hostname, validatedEntry);
      this.logger.debug(`Added new DNS cache entry for ${hostname}`, {
        label: "DNSCache",
        addresses: {
          ipv4: validatedEntry.addresses.ipv4.length,
          ipv6: validatedEntry.addresses.ipv6.length,
        },
        activeAddress: validatedEntry.activeAddress,
        family: validatedEntry.family,
      });
    }

    return Promise.resolve();
  }

  /**
   * Fallback DNS lookup when cache fails
   * Respects system DNS configuration
   */
  async fallbackLookup(hostname: string): Promise<DnsCache> {
    this.logger.debug(`Performing fallback DNS lookup for ${hostname}`, {
      label: "DNSCache",
    });

    // Try different DNS resolution methods
    const strategies = [
      this.tryNodeDefaultLookup.bind(this),
      this.tryNodePromisesLookup.bind(this),
    ];

    let lastError: unknown | null = null;

    for (const strategy of strategies) {
      try {
        const result = await strategy(hostname);
        if (
          result &&
          (result.addresses.ipv4.length > 0 || result.addresses.ipv6.length > 0)
        ) {
          return result;
        }
      } catch (error) {
        lastError = error;
        this.logger.debug(
          `Fallback strategy failed for ${hostname}: ${
            error instanceof Error ? error.message : error
          }`,
          {
            label: "DNSCache",
            strategy: strategy.name,
          }
        );
      }
    }

    throw (
      lastError ||
      new Error(`All DNS fallback strategies failed for ${hostname}`)
    );
  }

  /**
   * Attempt lookup using Node's default dns.lookup
   */
  private async tryNodeDefaultLookup(hostname: string): Promise<DnsCache> {
    return new Promise((resolve, reject) => {
      dns.lookup(hostname, { all: true }, (err, addresses) => {
        if (err) {
          reject(err);
          return;
        }

        if (!addresses || addresses.length === 0) {
          reject(new Error("No addresses returned"));
          return;
        }

        const ipv4Addresses = addresses
          .filter((a) => a.family === 4)
          .map((a) => a.address);

        const ipv6Addresses = addresses
          .filter((a) => a.family === 6)
          .map((a) => a.address);

        let activeAddress: string;
        let family: number;

        if (ipv6Addresses.length > 0) {
          activeAddress = ipv6Addresses[0];
          family = 6;
        } else if (ipv4Addresses.length > 0) {
          activeAddress = ipv4Addresses[0];
          family = 4;
        } else {
          reject(new Error("No valid addresses found"));
          return;
        }

        resolve({
          addresses: { ipv4: ipv4Addresses, ipv6: ipv6Addresses },
          activeAddress,
          family,
          timestamp: Date.now(),
          ttl: Math.min(Math.max(this.forceMinTtl, 60000), this.forceMaxTtl),
          hits: 0,
          misses: 0,
        });
      });
    });
  }

  /**
   * Try lookup using Node's dns.promises API directly
   * This uses a different internal implementation than dns.lookup
   */
  private async tryNodePromisesLookup(hostname: string): Promise<DnsCache> {
    const [ipv4Results, ipv6Results] = await Promise.allSettled([
      this.resolver.resolve4(hostname).catch(() => []),
      this.resolver.resolve6(hostname).catch(() => []),
    ]);

    const ipv4Addresses =
      ipv4Results.status === "fulfilled" ? ipv4Results.value : [];
    const ipv6Addresses =
      ipv6Results.status === "fulfilled" ? ipv6Results.value : [];

    if (ipv4Addresses.length === 0 && ipv6Addresses.length === 0) {
      throw new Error("No addresses resolved");
    }

    let activeAddress: string;
    let family: number;

    if (ipv6Addresses.length > 0) {
      activeAddress = ipv6Addresses[0];
      family = 6;
    } else {
      activeAddress = ipv4Addresses[0];
      family = 4;
    }

    return {
      addresses: { ipv4: ipv4Addresses, ipv6: ipv6Addresses },
      activeAddress,
      family,
      timestamp: Date.now(),
      ttl: 30000,
      hits: 0,
      misses: 0,
    };
  }

  getStats(): DnsStats {
    return {
      size: this.cache.size,
      cacheMaxEntries: this.cache.max,
      hits: this.stats.hits,
      misses: this.stats.misses,
      failures: this.stats.failures,
      ipv4Fallbacks: this.stats.ipv4Fallbacks,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses || 1),
    };
  }

  getCacheEntries(): DnsEntries {
    const entries: DnsEntries = {};

    for (const [hostname, data] of this.cache.entries()) {
      const age = Date.now() - data.timestamp;
      const ttl = Math.max(0, data.ttl - age);

      entries[hostname] = {
        addresses: {
          ipv4: data.addresses.ipv4.length,
          ipv6: data.addresses.ipv6.length,
        },
        activeAddress: data.activeAddress,
        family: data.family,
        age,
        ttl,
        hits: data.hits,
        misses: data.misses,
      };
    }

    return entries;
  }

  getCacheEntry(hostname: string): DnsEntry | null {
    const entry = this.cache.get(hostname);
    if (!entry) {
      return null;
    }

    return {
      addresses: {
        ipv4: entry.addresses.ipv4.length,
        ipv6: entry.addresses.ipv6.length,
      },
      activeAddress: entry.activeAddress,
      family: entry.family,
      age: Date.now() - entry.timestamp,
      ttl: Math.max(0, entry.ttl - (Date.now() - entry.timestamp)),
      hits: entry.hits,
      misses: entry.misses,
    };
  }

  clearHostname(hostname: string): void {
    if (!hostname || hostname.length === 0) {
      return;
    }

    if (this.cache.has(hostname)) {
      this.cache.delete(hostname);
      this.logger.debug(`Cleared DNS cache entry for ${hostname}`, {
        label: "DNSCache",
      });
    }
  }

  clear(hostname?: string): void {
    if (hostname && hostname.length > 0) {
      this.clearHostname(hostname);
      return;
    }

    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.failures = 0;
    this.stats.ipv4Fallbacks = 0;
    this.logger.debug("DNS cache cleared", { label: "DNSCache" });
  }
}
