import { describe, it, expect } from "vitest";
import { matchPattern } from "../pattern-matcher";

describe("Comprehensive Pattern Testing - Apex Domains", () => {
  const apexPatterns = [".", "*"];

  apexPatterns.forEach((pattern) => {
    it(`${pattern} should match various apex domains`, () => {
      const apexHosts = [
        "example.com",
        "google.com",
        "localhost",
        "test.dev",
        "my-app.io",
        "site123.net",
        // 3 parts: NOT detected as apex. There is no Public Suffix List, so a
        // two-label public suffix like .co.uk counts as a subdomain level — the
        // any-apex pattern does NOT match it (asserted explicitly below).
        "example.co.uk",
      ];

      apexHosts.forEach((host) => {
        const parts = host.split(".");
        if (parts.length === 2) {
          expect(matchPattern(pattern, host, "/", parts)).toBe(true);
        }
      });

      // Pin the dot-count limitation: a 2-label public suffix is treated as a
      // subdomain (3 parts), so an any-apex pattern does not match it.
      const coUk = "example.co.uk".split(".");
      expect(matchPattern(pattern, "example.co.uk", "/", coUk)).toBe(false);
    });

    it(`${pattern} should NOT match subdomains`, () => {
      const subdomainHosts = [
        "www.example.com",
        "api.google.com",
        "admin.test.dev",
        "staging.my-app.io",
        "v2.api.example.com",
      ];

      subdomainHosts.forEach((host) => {
        const parts = host.split(".");
        expect(matchPattern(pattern, host, "/", parts)).toBe(false);
      });
    });
  });
});

describe("Comprehensive Pattern Testing - Any Domain", () => {
  it("** should match absolutely any domain", () => {
    const allHosts = [
      "example.com",
      "www.example.com",
      "api.example.com",
      "a.b.c.example.com",
      "deeply.nested.subdomain.example.com",
      "localhost",
      "test.dev",
      "admin.staging.v2.example.io",
    ];

    allHosts.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("**", host, "/", parts)).toBe(true);
    });
  });
});

describe("Comprehensive Pattern Testing - Single Subdomains", () => {
  it("*. should match only single-level subdomains", () => {
    const singleSubdomains = [
      "www.example.com",
      "api.google.com",
      "admin.test.dev",
      "staging.myapp.io",
      "v1.service.net",
      "blog.site.org",
    ];

    singleSubdomains.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("*.", host, "/", parts)).toBe(true);
    });
  });

  it("*. should NOT match apex or multi-level", () => {
    const nonMatching = [
      "example.com", // Apex
      "localhost", // Apex
      "a.b.example.com", // Multi-level
      "staging.api.example.com", // Multi-level
    ];

    nonMatching.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("*.", host, "/", parts)).toBe(false);
    });
  });
});

describe("Comprehensive Pattern Testing - Multi-level Subdomains", () => {
  it("**. should match only multi-level subdomains (2+ levels)", () => {
    const multiLevel = [
      "a.b.example.com",
      "staging.api.example.com",
      "v2.admin.test.dev",
      "pr-123.preview.myapp.io",
      "deeply.nested.sub.domain.com",
    ];

    multiLevel.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("**.", host, "/", parts)).toBe(true);
    });
  });

  it("**. should NOT match apex or single-level", () => {
    const nonMatching = [
      "example.com", // Apex
      "www.example.com", // Single-level
      "api.google.com", // Single-level
    ];

    nonMatching.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("**.", host, "/", parts)).toBe(false);
    });
  });
});

describe("Comprehensive Pattern Testing - TLD Patterns", () => {
  it("*.com should match any apex .com domain", () => {
    const comDomains = [
      "example.com",
      "google.com",
      "test.com",
      "my-site.com",
      "abc123.com",
    ];

    comDomains.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("*.com", host, "/", parts)).toBe(true);
    });
  });

  it("*.com should NOT match non-.com or subdomains", () => {
    const nonMatching = [
      "example.net",
      "google.io",
      "www.example.com", // Subdomain
      "api.google.com", // Subdomain
    ];

    nonMatching.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("*.com", host, "/", parts)).toBe(false);
    });
  });

  it("should match other TLDs", () => {
    expect(matchPattern("*.dev", "myapp.dev", "/", ["myapp", "dev"])).toBe(
      true,
    );
    expect(matchPattern("*.io", "service.io", "/", ["service", "io"])).toBe(
      true,
    );
    expect(
      matchPattern("*.org", "nonprofit.org", "/", ["nonprofit", "org"]),
    ).toBe(true);
    expect(matchPattern("*.net", "example.net", "/", ["example", "net"])).toBe(
      true,
    );
  });
});

describe("Comprehensive Pattern Testing - Specific Subdomains", () => {
  const subdomainNames = ["admin", "api", "www", "staging", "v2", "blog"];

  subdomainNames.forEach((subdomain) => {
    it(`${subdomain}.* should match ${subdomain} of any apex domain`, () => {
      const hosts = [
        `${subdomain}.example.com`,
        `${subdomain}.google.com`,
        `${subdomain}.test.dev`,
        `${subdomain}.myapp.io`,
      ];

      hosts.forEach((host) => {
        const parts = host.split(".");
        expect(matchPattern(`${subdomain}.*`, host, "/", parts)).toBe(true);
      });
    });

    it(`${subdomain}.* should NOT match different subdomains or multi-level`, () => {
      const nonMatching = [
        "example.com", // No subdomain
        "other.example.com", // Different subdomain
        `${subdomain}.sub.example.com`, // Multi-level
        `pre-${subdomain}.example.com`, // Different prefix
      ];

      nonMatching.forEach((host) => {
        const parts = host.split(".");
        expect(matchPattern(`${subdomain}.*`, host, "/", parts)).toBe(false);
      });
    });

    it(`${subdomain}.** should match ${subdomain} of any domain depth`, () => {
      const hosts = [
        `${subdomain}.example.com`,
        `${subdomain}.sub.example.com`,
        `${subdomain}.a.b.c.example.com`,
      ];

      hosts.forEach((host) => {
        const parts = host.split(".");
        expect(matchPattern(`${subdomain}.**`, host, "/", parts)).toBe(true);
      });
    });
  });
});

describe("Comprehensive Pattern Testing - Domain-Specific Patterns", () => {
  it("*.example.com should match single subdomains only", () => {
    const matching = [
      "www.example.com",
      "api.example.com",
      "staging.example.com",
      "v2.example.com",
      "admin.example.com",
    ];

    matching.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("*.example.com", host, "/", parts)).toBe(true);
    });
  });

  it("*.example.com should NOT match apex, multi-level, or other domains", () => {
    const nonMatching = [
      "example.com", // Apex
      "a.b.example.com", // Multi-level
      "api.google.com", // Different domain
      "example.net", // Different domain
    ];

    nonMatching.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("*.example.com", host, "/", parts)).toBe(false);
    });
  });

  it("**.example.com should match any depth subdomains", () => {
    const matching = [
      "api.example.com",
      "a.b.example.com",
      "staging.api.example.com",
      "deeply.nested.sub.example.com",
    ];

    matching.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("**.example.com", host, "/", parts)).toBe(true);
    });
  });

  it("**.example.com should NOT match apex or other domains", () => {
    const nonMatching = [
      "example.com", // Apex
      "api.google.com", // Different domain
      "example.net", // Different domain
    ];

    nonMatching.forEach((host) => {
      const parts = host.split(".");
      expect(matchPattern("**.example.com", host, "/", parts)).toBe(false);
    });
  });
});

describe("Comprehensive Pattern Testing - Path Patterns", () => {
  const pathCombinations = [
    {
      pattern: "./admin",
      host: "example.com",
      paths: ["/admin", "/admin/users", "/admin/settings/profile"],
    },
    {
      pattern: "./api",
      host: "test.dev",
      paths: ["/api", "/api/v2", "/api/v2/users"],
    },
    {
      pattern: "./blog",
      host: "mysite.io",
      paths: ["/blog", "/blog/post-1", "/blog/2024/january"],
    },
    {
      pattern: "*./dashboard",
      host: "app.example.com",
      paths: ["/dashboard", "/dashboard/settings"],
    },
    {
      pattern: "*./api",
      host: "v2.example.com",
      paths: ["/api", "/api/users", "/api/v1/posts"],
    },
    {
      pattern: "admin./settings",
      host: "admin.example.com",
      paths: ["/settings", "/settings/user"],
    },
    {
      pattern: "**/health",
      host: "example.com",
      paths: ["/health", "/health/check"],
    },
    {
      pattern: "**/health",
      host: "api.example.com",
      paths: ["/health", "/health/status"],
    },
  ];

  pathCombinations.forEach(({ pattern, host, paths }) => {
    it(`${pattern} should match ${host} with correct paths`, () => {
      const parts = host.split(".");

      paths.forEach((path) => {
        expect(matchPattern(pattern, host, path, parts)).toBe(true);
      });
    });

    it(`${pattern} should NOT match ${host} with wrong paths`, () => {
      const parts = host.split(".");
      const wrongPaths = ["/other", "/different", "/notmatching"];

      wrongPaths.forEach((path) => {
        expect(matchPattern(pattern, host, path, parts)).toBe(false);
      });
    });
  });

  it("should NOT match path when domain doesn't match", () => {
    expect(
      matchPattern("./admin", "www.example.com", "/admin", [
        "www",
        "example",
        "com",
      ]),
    ).toBe(false);
    expect(
      matchPattern("*./api", "example.com", "/api", ["example", "com"]),
    ).toBe(false);
    expect(
      matchPattern("admin./blog", "api.example.com", "/blog", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(false);
  });
});

describe("Comprehensive Pattern Testing - Exact Matches", () => {
  it("should match exact domain patterns", () => {
    const exactMatches = [
      { pattern: "example.com", host: "example.com" },
      { pattern: "google.com", host: "google.com" },
      { pattern: "test.dev", host: "test.dev" },
      { pattern: "www.example.com", host: "www.example.com" },
      { pattern: "api.google.com", host: "api.google.com" },
      {
        pattern: "admin.staging.example.com",
        host: "admin.staging.example.com",
      },
      { pattern: "localhost", host: "localhost" },
    ];

    exactMatches.forEach(({ pattern, host }) => {
      const parts = host.split(".");
      expect(matchPattern(pattern, host, "/", parts)).toBe(true);
    });
  });

  it("should NOT match similar but different domains", () => {
    expect(
      matchPattern("example.com", "examples.com", "/", ["examples", "com"]),
    ).toBe(false);
    expect(
      matchPattern("www.example.com", "ww.example.com", "/", [
        "ww",
        "example",
        "com",
      ]),
    ).toBe(false);
    expect(
      matchPattern("api.example.com", "api.examples.com", "/", [
        "api",
        "examples",
        "com",
      ]),
    ).toBe(false);
  });

  it("should match exact domain with path", () => {
    const exactPathMatches = [
      { pattern: "example.com/admin", host: "example.com", path: "/admin" },
      {
        pattern: "example.com/admin",
        host: "example.com",
        path: "/admin/users",
      },
      { pattern: "api.example.com/v2", host: "api.example.com", path: "/v2" },
      {
        pattern: "api.example.com/v2",
        host: "api.example.com",
        path: "/v2/users",
      },
      { pattern: "localhost/api", host: "localhost", path: "/api" },
      { pattern: "localhost/api", host: "localhost", path: "/api/test" },
    ];

    exactPathMatches.forEach(({ pattern, host, path }) => {
      const parts = host.split(".");
      expect(matchPattern(pattern, host, path, parts)).toBe(true);
    });
  });
});

describe("Comprehensive Pattern Testing - Complex Scenarios", () => {
  it("should handle patterns with hyphens in names", () => {
    expect(
      matchPattern("my-app.*", "my-app.example.com", "/", [
        "my-app",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("*.my-site.com", "api.my-site.com", "/", [
        "api",
        "my-site",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("staging-v2.*", "staging-v2.example.com", "/", [
        "staging-v2",
        "example",
        "com",
      ]),
    ).toBe(true);
  });

  it("should handle patterns with numbers", () => {
    expect(
      matchPattern("v2.*", "v2.example.com", "/", ["v2", "example", "com"]),
    ).toBe(true);
    expect(
      matchPattern("api2.*", "api2.google.com", "/", ["api2", "google", "com"]),
    ).toBe(true);
    expect(
      matchPattern("*.v3.com", "test.v3.com", "/", ["test", "v3", "com"]),
    ).toBe(true);
  });

  it("should handle localhost variants", () => {
    expect(matchPattern("localhost", "localhost", "/", ["localhost"])).toBe(
      true,
    );
    expect(matchPattern(".", "localhost", "/", ["localhost"])).toBe(false); // localhost is 1 part, not apex
    expect(
      matchPattern("*.localhost", "admin.localhost", "/", [
        "admin",
        "localhost",
      ]),
    ).toBe(true);
  });

  it("should handle different TLD lengths", () => {
    // 2-letter TLDs
    expect(matchPattern("*.io", "example.io", "/", ["example", "io"])).toBe(
      true,
    );
    expect(matchPattern("*.uk", "example.uk", "/", ["example", "uk"])).toBe(
      true,
    );

    // 3-letter TLDs
    expect(matchPattern("*.com", "example.com", "/", ["example", "com"])).toBe(
      true,
    );
    expect(matchPattern("*.dev", "example.dev", "/", ["example", "dev"])).toBe(
      true,
    );
    expect(matchPattern("*.org", "example.org", "/", ["example", "org"])).toBe(
      true,
    );

    // 4-letter TLDs
    expect(
      matchPattern("*.info", "example.info", "/", ["example", "info"]),
    ).toBe(true);
  });
});

describe("Comprehensive Pattern Testing - Path Edge Cases", () => {
  it("should match paths with various depths", () => {
    const matchingPaths = ["/a", "/a/b", "/a/b/c"];

    const nonMatchingPaths = [
      "/api/v2/users/123",
      "/admin/settings/profile/security",
      "/b",
    ];

    matchingPaths.forEach((path) => {
      expect(matchPattern("./a", "example.com", path, ["example", "com"])).toBe(
        true,
      );
    });

    nonMatchingPaths.forEach((path) => {
      expect(matchPattern("./a", "example.com", path, ["example", "com"])).toBe(
        false,
      );
    });
  });

  it("should match paths with special characters", () => {
    const paths = ["/api-v2", "/api_v2", "/admin-panel", "/user_settings"];

    paths.forEach((path) => {
      const pattern = `.${path}`;
      expect(
        matchPattern(pattern, "example.com", path, ["example", "com"]),
      ).toBe(true);
      expect(
        matchPattern(pattern, "example.com", path + "/sub", ["example", "com"]),
      ).toBe(true);
    });
  });

  it("should NOT match when path doesn't start correctly", () => {
    expect(
      matchPattern("./admin", "example.com", "/administrator", [
        "example",
        "com",
      ]),
    ).toBe(false);
    expect(
      matchPattern("./api", "example.com", "/apis", ["example", "com"]),
    ).toBe(false);
    expect(
      matchPattern("./blog", "example.com", "/blogs", ["example", "com"]),
    ).toBe(false);
  });

  it("should handle root path", () => {
    expect(matchPattern(".", "example.com", "/", ["example", "com"])).toBe(
      true,
    );
    expect(
      matchPattern("admin.*", "admin.example.com", "/", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("**", "any.domain.com", "/", ["any", "domain", "com"]),
    ).toBe(true);
  });
});

describe("Comprehensive Pattern Testing - Subdomain with Patterns", () => {
  it("admin. should match admin subdomain with trailing dot", () => {
    expect(
      matchPattern("admin.", "admin.example.com", "/", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin.", "admin.google.com", "/", [
        "admin",
        "google",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("api.", "api.test.dev", "/", ["api", "test", "dev"]),
    ).toBe(true);
  });

  it("subdomain. should NOT match wrong subdomain or multi-level", () => {
    expect(
      matchPattern("admin.", "api.example.com", "/", ["api", "example", "com"]),
    ).toBe(false);
    expect(
      matchPattern("admin.", "admin.sub.example.com", "/", [
        "admin",
        "sub",
        "example",
        "com",
      ]),
    ).toBe(false);
    expect(matchPattern("admin.", "example.com", "/", ["example", "com"])).toBe(
      false,
    );
  });
});

describe("Comprehensive Pattern Testing - Mixed Patterns", () => {
  it("should handle subdomain + specific domain patterns", () => {
    expect(
      matchPattern("*.example.com", "www.example.com", "/", [
        "www",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("*.example.com", "api.example.com", "/", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("**.example.com", "a.b.example.com", "/", [
        "a",
        "b",
        "example",
        "com",
      ]),
    ).toBe(true);
  });

  it("should handle subdomain + TLD patterns", () => {
    expect(
      matchPattern("admin.*", "admin.example.com", "/", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin.*", "admin.test.dev", "/", ["admin", "test", "dev"]),
    ).toBe(true);
    expect(
      matchPattern("admin.*", "admin.myapp.io", "/", ["admin", "myapp", "io"]),
    ).toBe(true);
  });

  it("should handle path patterns with domain specificity", () => {
    // Specific domain + path
    expect(
      matchPattern("example.com/api", "example.com", "/api", [
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("example.com/api", "example.com", "/api/v2", [
        "example",
        "com",
      ]),
    ).toBe(true);

    // Any apex + path
    expect(
      matchPattern("./admin", "example.com", "/admin", ["example", "com"]),
    ).toBe(true);
    expect(
      matchPattern("./admin", "google.com", "/admin", ["google", "com"]),
    ).toBe(true);

    // Subdomain pattern + path
    expect(
      matchPattern("*./api", "v2.example.com", "/api", [
        "v2",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin./settings", "admin.example.com", "/settings", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
  });
});

describe("Comprehensive Pattern Testing - Edge Cases", () => {
  it("should handle single-part domains (localhost)", () => {
    expect(matchPattern("localhost", "localhost", "/", ["localhost"])).toBe(
      true,
    );
    expect(matchPattern(".", "localhost", "/", ["localhost"])).toBe(false); // . requires 2 parts
    expect(matchPattern("**", "localhost", "/", ["localhost"])).toBe(true);
  });

  it("should handle very long subdomains", () => {
    const longHost = "a.b.c.d.e.f.g.example.com";
    const parts = longHost.split(".");

    expect(matchPattern("**.", longHost, "/", parts)).toBe(true);
    expect(matchPattern("**.example.com", longHost, "/", parts)).toBe(true);
    expect(matchPattern("**", longHost, "/", parts)).toBe(true);
    expect(matchPattern("*.", longHost, "/", parts)).toBe(false); // Too many levels
  });

  it("should NOT match patterns that are close but wrong", () => {
    // Similar prefixes
    expect(
      matchPattern("api.*", "apis.example.com", "/", [
        "apis",
        "example",
        "com",
      ]),
    ).toBe(false);
    expect(
      matchPattern("admin.*", "administrator.example.com", "/", [
        "administrator",
        "example",
        "com",
      ]),
    ).toBe(false);

    // Similar paths
    expect(
      matchPattern("./admin", "example.com", "/admins", ["example", "com"]),
    ).toBe(false);
    expect(
      matchPattern("./api", "example.com", "/api-v2", ["example", "com"]),
    ).toBe(false);
  });

  it("should handle case sensitivity correctly", () => {
    // Hosts are case-insensitive per RFC 3986: both the pattern literal and the
    // request host are folded to lowercase before matching.
    expect(
      matchPattern("Admin.*", "Admin.example.com", "/", [
        "Admin",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin.*", "Admin.example.com", "/", [
        "Admin",
        "example",
        "com",
      ]),
    ).toBe(true);
  });
});

describe("Comprehensive Pattern Testing - Multiple Specific Domains", () => {
  it("should match various domain-specific patterns", () => {
    const tests = [
      { pattern: "example.com", host: "example.com" },
      { pattern: "google.com", host: "google.com" },
      { pattern: "api.example.com", host: "api.example.com" },
      { pattern: "staging.api.example.com", host: "staging.api.example.com" },
      { pattern: "v2.admin.test.dev", host: "v2.admin.test.dev" },
    ];

    tests.forEach(({ pattern, host }) => {
      const parts = host.split(".");
      expect(matchPattern(pattern, host, "/", parts)).toBe(true);
    });
  });

  it("should match specific domain with various paths", () => {
    const tests = [
      { pattern: "example.com/api", host: "example.com", path: "/api" },
      { pattern: "example.com/api", host: "example.com", path: "/api/v2" },
      { pattern: "example.com/api/v2", host: "example.com", path: "/api/v2" },
      {
        pattern: "example.com/api/v2",
        host: "example.com",
        path: "/api/v2/users",
      },
      {
        pattern: "admin.example.com/dashboard",
        host: "admin.example.com",
        path: "/dashboard",
      },
    ];

    tests.forEach(({ pattern, host, path }) => {
      const parts = host.split(".");
      expect(matchPattern(pattern, host, path, parts)).toBe(true);
    });
  });
});

describe("Comprehensive Pattern Testing - Wildcard Combinations", () => {
  it("should test all wildcard combinations", () => {
    const wildcardsTests = [
      // Apex wildcards
      { pattern: ".", host: "example.com", match: true },
      { pattern: "*", host: "example.com", match: true },
      { pattern: ".", host: "www.example.com", match: false },

      // Subdomain wildcards
      { pattern: "*.", host: "www.example.com", match: true },
      { pattern: "*.", host: "api.test.dev", match: true },
      { pattern: "**.", host: "a.b.example.com", match: true },
      { pattern: "**.", host: "x.y.z.test.dev", match: true },

      // Domain wildcards
      { pattern: "**", host: "example.com", match: true },
      { pattern: "**", host: "www.example.com", match: true },
      { pattern: "**", host: "a.b.c.example.com", match: true },

      // Subdomain + wildcard TLD
      { pattern: "admin.*", host: "admin.example.com", match: true },
      { pattern: "admin.*", host: "admin.test.dev", match: true },
      { pattern: "admin.**", host: "admin.sub.example.com", match: true },

      // Wildcard + specific domain
      { pattern: "*.example.com", host: "api.example.com", match: true },
      { pattern: "**.example.com", host: "a.b.example.com", match: true },
    ];

    wildcardsTests.forEach(({ pattern, host, match }) => {
      const parts = host.split(".");
      expect(matchPattern(pattern, host, "/", parts)).toBe(match);
    });
  });
});

describe("Comprehensive Pattern Testing - Real-World Scenarios", () => {
  it("should handle typical SaaS multi-tenant patterns", () => {
    // Company subdomains
    expect(
      matchPattern("*.", "acme.myapp.com", "/", ["acme", "myapp", "com"]),
    ).toBe(true);
    expect(
      matchPattern("*.", "bigcorp.myapp.com", "/", ["bigcorp", "myapp", "com"]),
    ).toBe(true);

    // Reserved subdomains
    expect(
      matchPattern("www.*", "www.myapp.com", "/", ["www", "myapp", "com"]),
    ).toBe(true);
    expect(
      matchPattern("admin.*", "admin.myapp.com", "/", [
        "admin",
        "myapp",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("api.*", "api.myapp.com", "/", ["api", "myapp", "com"]),
    ).toBe(true);
  });

  it("should handle staging/preview environments", () => {
    expect(
      matchPattern("staging.*", "staging.example.com", "/", [
        "staging",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("preview.*", "preview.example.com", "/", [
        "preview",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("**.", "pr-123.preview.example.com", "/", [
        "pr-123",
        "preview",
        "example",
        "com",
      ]),
    ).toBe(true);
  });

  it("should handle API versioning patterns", () => {
    expect(
      matchPattern("api./v1", "api.example.com", "/v1", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("api./v2", "api.example.com", "/v2", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("*./v3", "v3.example.com", "/v3", ["v3", "example", "com"]),
    ).toBe(true);
  });

  it("should handle admin panel patterns", () => {
    expect(
      matchPattern("./admin", "example.com", "/admin", ["example", "com"]),
    ).toBe(true);
    expect(
      matchPattern("admin.*", "admin.example.com", "/dashboard", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin./dashboard", "admin.example.com", "/dashboard", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
  });

  it("should handle documentation sites", () => {
    expect(
      matchPattern("docs.*", "docs.example.com", "/", [
        "docs",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("*.example.com", "docs.example.com", "/", [
        "docs",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("./docs", "example.com", "/docs", ["example", "com"]),
    ).toBe(true);
  });
});

describe("Comprehensive Pattern Testing - Negative Cases", () => {
  it("should NOT match when parts don't align", () => {
    // Subdomain pattern on apex
    expect(matchPattern("*.", "example.com", "/", ["example", "com"])).toBe(
      false,
    );

    // Apex pattern on subdomain
    expect(
      matchPattern(".", "www.example.com", "/", ["www", "example", "com"]),
    ).toBe(false);

    // Multi-level pattern on single-level
    expect(
      matchPattern("**.", "www.example.com", "/", ["www", "example", "com"]),
    ).toBe(false);
  });

  it("should NOT match when TLDs don't align", () => {
    expect(matchPattern("*.com", "example.net", "/", ["example", "net"])).toBe(
      false,
    );
    expect(matchPattern("*.dev", "example.com", "/", ["example", "com"])).toBe(
      false,
    );
    expect(
      matchPattern("*.example.com", "api.example.net", "/", [
        "api",
        "example",
        "net",
      ]),
    ).toBe(false);
  });

  it("should NOT match when subdomain name doesn't match", () => {
    expect(
      matchPattern("admin.*", "api.example.com", "/", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(false);
    expect(
      matchPattern("www.*", "api.example.com", "/", ["api", "example", "com"]),
    ).toBe(false);
    expect(
      matchPattern("staging.*", "production.example.com", "/", [
        "production",
        "example",
        "com",
      ]),
    ).toBe(false);
  });

  it("should NOT match when paths don't match", () => {
    expect(
      matchPattern("./admin", "example.com", "/api", ["example", "com"]),
    ).toBe(false);
    expect(
      matchPattern("*./api", "api.example.com", "/admin", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(false);
    expect(
      matchPattern("admin./blog", "admin.example.com", "/admin", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(false);
  });
});
