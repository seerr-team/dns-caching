import dns from "dns";
import { jest, describe, expect, test } from "@jest/globals";
import { DnsCacheManager } from "./index";

jest.setTimeout(20000);

const defaultTtl = 2000;

describe("DnsCacheManager Lookup Tests", () => {
  let manager: DnsCacheManager = new DnsCacheManager();

  test("caches DNS lookups", async () => {
    // Lookup the address twice
    const res1 = await manager.lookup("test-jest.local");
    const res2 = await manager.lookup("test-jest.local");

    // We check that the active address is correct
    expect(res1.activeAddress).toBe("2001:db8::1");

    // We check that this is the exact same object from cache
    expect(res1).toBe(res2);
  });

  test("respects TTL expiration", async () => {
    // Wait for TTL expiration
    await manager.lookup("test-jest.local");
    await new Promise((resolve) => setTimeout(resolve, defaultTtl + 1000));

    // Check that the cache entry has expired
    const res = await manager.lookup("test-jest.local");
    expect(res.hits).toBe(0);
  });

  test("switches to IPv4 when forced", async () => {
    // Test the forceIpv4 parameter of lookup
    await manager.lookup("test-jest.local");
    const res = await manager.lookup("test-jest.local", 0, true);
    expect(res.family).toBe(4);
  });

  test("handles localhost special case", async () => {
    // Test localhost resolution
    const res1 = await manager.lookup("localhost");
    expect(res1.addresses.ipv4).toContain("127.0.0.1");
    expect(res1.addresses.ipv6).toContain("::1");

    // Test ::1 resolution
    const res2 = await manager.lookup("::1");
    expect(res2.addresses.ipv6).toContain("::1");
  });

  test("falls back when resolver fails", async () => {
    // Create a DnsCacheManager instance with failing resolvers
    const failingManager = new DnsCacheManager();
    failingManager["resolver"].resolve4 = jest
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error("fail")) as any;
    failingManager["resolver"].resolve6 = jest
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error("fail")) as any;

    // Check that the lookup fails
    await expect(failingManager.lookup("nonexistent.local")).rejects.toThrow();
  });

  test("dns.lookup override works with callback", (done) => {
    manager.initialize();
    dns.lookup("test-jest.local", (err, address) => {
      expect(err).toBeNull();
      expect(["1.2.3.4", "2001:db8::1"]).toContainEqual(address);
      done();
    });
  });

  test("dns.lookup override works with promises", async () => {
    const result = await (dns.lookup as any).__promisify__("test-jest.local");
    expect(["1.2.3.4", "2001:db8::1"]).toContainEqual(result.address);
  });

  test("dns.lookup override works with dns/promises", async () => {
    const result = await dns.promises.lookup("test-jest.local");
    expect(["1.2.3.4", "2001:db8::1"]).toContainEqual(result.address);
  });

  test("updateCache merges entries", async () => {
    await manager.updateCache("custom.local", {
      addresses: { ipv4: ["1.1.1.1"], ipv6: [] },
      activeAddress: "1.1.1.1",
      family: 4,
      timestamp: Date.now(),
      ttl: 60000,
      hits: 0,
      misses: 0,
    });
    const entry = manager.getCacheEntry("custom.local");
    expect(entry?.activeAddress).toBe("1.1.1.1");
  });

  test("clearHostname removes entry", async () => {
    // Test clearing a specific hostname
    await manager.lookup("test-jest.local");
    manager.clearHostname("test-jest.local");
    expect(manager.getCacheEntry("test-jest.local")).toBeNull();
  });

  test("clear() wipes all stats & cache", () => {
    // Test clearing all cache entries
    manager.clear();
    expect(manager.getStats().size).toBe(0);
  });

  test("dns.lookup honors family:4 (Force IPv4 ON)", (done) => {
    dns.lookup("test-jest.local", { family: 4 }, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe("1.2.3.4");
      expect(family).toBe(4);
      done();
    });
  });

  test("dns.lookup default (Force IPv4 OFF) uses cache default (ipv6-first here)", (done) => {
    manager.clearHostname("test-jest.local");

    dns.lookup("test-jest.local", (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe("2001:db8::1");
      expect(family).toBe(6);
      done();
    });
  });

  test("dns.lookup with { all: true } returns both A and AAAA", (done) => {
    dns.lookup("test-jest.local", { all: true }, (err, addresses) => {
      expect(err).toBeNull();
      const hasV4 = (addresses as dns.LookupAddress[]).some(
        (a) => a.family === 4 && a.address === "1.2.3.4"
      );
      const hasV6 = (addresses as dns.LookupAddress[]).some(
        (a) => a.family === 6 && a.address === "2001:db8::1"
      );
      expect(hasV4).toBe(true);
      expect(hasV6).toBe(true);
      done();
    });
  });

  test("dns.lookup returns ENOTFOUND when family:4 is requested but only AAAA exists", (done) => {
    jest.spyOn(manager as any, "resolveWithTtl").mockResolvedValue({
      addresses: { ipv4: [], ipv6: ["2001:db8::2"] },
      ttl: 60000,
    });

    dns.lookup("onlyv6.local", { family: 4 }, (err, address, family) => {
      expect(err).toBeTruthy();
      expect((err as any).code).toBe("ENOTFOUND");
      expect(address).toBeUndefined();
      expect(family).toBeUndefined();
      done();
    });
  });

  test("dns.lookup returns ENOTFOUND when family:6 is requested but only A exists", (done) => {
    jest.spyOn(manager as any, "resolveWithTtl").mockResolvedValue({
      addresses: { ipv4: ["93.184.216.34"], ipv6: [] },
      ttl: 60000,
    });

    dns.lookup("onlyv4.local", { family: 6 }, (err, address, family) => {
      expect(err).toBeTruthy();
      expect((err as any).code).toBe("ENOTFOUND");
      expect(address).toBeUndefined();
      expect(family).toBeUndefined();
      done();
    });
  });

  test("promisified lookup honors family:4 / family:6", async () => {
    const v4 = await (dns.lookup as any).__promisify__("test-jest.local", {
      family: 4,
    });
    expect(v4.address).toBe("1.2.3.4");
    expect(v4.family).toBe(4);

    const v6 = await (dns.lookup as any).__promisify__("test-jest.local", {
      family: 6,
    });
    expect(v6.address).toBe("2001:db8::1");
    expect(v6.family).toBe(6);
  });
});

describe("DnsCacheManager Force TTL Options", () => {
  test("respects forceMaxTtl option", async () => {
    // Create a DnsCacheManager instance with a specific forceMaxTtl
    const forceMaxTtl = 1000; // 1 second
    const manager = new DnsCacheManager({ forceMaxTtl });

    // Perform a DNS lookup
    const res1 = await manager.lookup("test-jest.local");
    expect(res1.activeAddress).toBe("2001:db8::1");

    // Wait for a short period to ensure the entry is still in cache
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Perform the lookup again
    const res2 = await manager.lookup("test-jest.local");
    expect(res2.activeAddress).toBe("2001:db8::1");

    // Wait for the forceMaxTtl to expire
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Perform the lookup again and check if the cache entry has expired
    const res3 = await manager.lookup("test-jest.local");
    expect(res3.hits).toBe(0);
  });

  test("respects forceMinTtl option", async () => {
    // Create a DnsCacheManager instance with a specific forceMinTtl
    const forceMinTtl = defaultTtl + 2000;
    const manager = new DnsCacheManager({ forceMinTtl });

    // Perform a DNS lookup
    const res1 = await manager.lookup("test-jest.local");
    expect(res1.activeAddress).toBe("2001:db8::1");

    // Wait for a short period to ensure the entry is still in cache
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Perform the lookup again
    const res2 = await manager.lookup("test-jest.local");
    expect(res2.activeAddress).toBe("2001:db8::1");

    // Check that the TTL is at least the forceMinTtl
    const entry = manager.getCacheEntry("test-jest.local");
    expect(entry?.ttl).toBeGreaterThanOrEqual(defaultTtl);
  });
});
