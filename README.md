# dns-caching

A small package to cache DNS lookups in Node.js, with support for custom DNS servers and TTL (time-to-live) settings.

![GitHub repo size](https://img.shields.io/github/repo-size/seerr-team/dns-caching) ![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/seerr-team/dns-caching/tests.yml?label=tests) [![NPM](https://img.shields.io/npm/v/dns-caching.svg)](https://www.npmjs.com/package/dns-caching) ![npm](https://img.shields.io/npm/dt/dns-caching) ![GitHub](https://img.shields.io/github/license/seerr-team/dns-caching) ![npm package minimized gzipped size](https://img.shields.io/bundlejs/size/dns-caching) 

## Install

| Package Manager | Command |
|---|---|
| NPM | `npm i dns-caching` |
| Yarn | `yarn add dns-caching` |
| PNPM | `pnpm add dns-caching` |

## Usage

### Basic Setup

Import the DnsCacheManager and initialize it with optional configurations:

```javascript
import DnsCacheManager from 'dns-caching';

const dnsCacheManager = new DnsCacheManager({
  cacheMaxEntries: 500, // Optional: Maximum number of entries in the cache
  forceMaxTtl: -1,      // Optional: Maximum TTL for cached entries in ms (-1 = no limit)
  forceMinTtl: 0,       // Optional: Minimum TTL for cached entries in ms
  maxRetries: 3,        // Optional: Maximum number of retries for DNS lookup
  logger: console,      // Optional: Custom logger
});
```

### Initialization

Initialize the DNS cache manager to override the default dns.lookup function:

```javascript
dnsCacheManager.initialize();
```

This will intercept all DNS lookups made using the `dns` module and cache the results.

### Performing DNS Lookups

Use the lookup method to perform DNS lookups with caching:

```javascript
async function performLookup(hostname) {
  try {
    const result = await dnsCacheManager.lookup(hostname);
    console.log(`DNS Lookup Result for ${hostname}:`, result);
  } catch (error) {
    console.error(`DNS Lookup Error for ${hostname}:`, error);
  }
}

performLookup('example.com');
```

### Getting Cache Statistics

Retrieve statistics about the cache performance:

```javascript
const stats = dnsCacheManager.getStats();
console.log('Cache Statistics:', stats);
```

### Clearing the Cache

Clear the DNS cache for a specific hostname or for all entries:

```javascript
// Clear cache for a specific hostname
dnsCacheManager.clearHostname('example.com');

// Clear the entire cache
dnsCacheManager.clear();
```

### Handling Network Errors

Report network errors to the DNS cache manager to handle address switching:

```javascript
dnsCacheManager.reportNetworkError('example.com');
```

### Advanced Configuration

For advanced use cases, you can customize the behavior of the DNS cache manager by providing a custom logger or adjusting the retry logic:

```javascript
const customLogger = {
  debug: (message, meta) => console.debug(message, meta),
  error: (message, meta) => console.error(message, meta),
};

const customDnsCacheManager = new DnsCacheManager({
  logger: customLogger,
  maxRetries: 3,
});
```

This setup will help you efficiently manage DNS lookups with caching, improving the performance and reliability of your application.

## Credits

Created by [fallenbagel](https://github.com/fallenbagel) and packaged by [gauthier-th](https://github.com/gauthier-thc)

## License

MIT © [Seerr Team](https://github.com/seerr-team)
