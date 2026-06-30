process.env.OB_USER ??= "ob_user@ob_oracle#obcluster";
process.env.OB_PASSWORD ??= "ob_password";
process.env.OB_COMPATIBILITY = "oracle";
process.env.OB_ALLOWED_SCHEMAS ??= "OB_USER";

await import("./mcp-smoke.mjs");
