import ipaddr from "ipaddr.js";

type IpAddress = ReturnType<typeof ipaddr.parse>;

type IpRule =
  | {
      type: "exact";
      address: IpAddress;
    }
  | {
      type: "cidr";
      address: IpAddress;
      bits: number;
    };

export function validateAllowedIpRules(rules: string[]): void {
  for (const rule of rules) {
    parseIpRule(rule);
  }
}

export function isIpAllowed(remoteAddress: string | undefined, rules: string[]): boolean {
  if (rules.length === 0) {
    return true;
  }

  const address = parseRemoteAddress(remoteAddress);
  if (!address) {
    return false;
  }

  return rules.some((rule) => matchesRule(address, parseIpRule(rule)));
}

function matchesRule(address: IpAddress, rule: IpRule): boolean {
  if (address.kind() !== rule.address.kind()) {
    return false;
  }

  if (rule.type === "exact") {
    return address.toNormalizedString() === rule.address.toNormalizedString();
  }

  return (address as { match: (other: IpAddress, bits: number) => boolean }).match(rule.address, rule.bits);
}

function parseIpRule(rule: string): IpRule {
  const trimmed = rule.trim();
  if (!trimmed) {
    throw new Error("OB_MCP_ALLOWED_IPS contains an empty entry.");
  }

  try {
    if (trimmed.includes("/")) {
      const [address, bits] = ipaddr.parseCIDR(trimmed);
      const normalizedAddress = normalizeIpAddress(address);
      return {
        type: "cidr",
        address: normalizedAddress,
        bits: normalizeCidrBits(address, normalizedAddress, bits)
      };
    }

    return {
      type: "exact",
      address: normalizeIpAddress(ipaddr.parse(trimmed))
    };
  } catch {
    throw new Error(`Invalid OB_MCP_ALLOWED_IPS entry "${rule}". Use an IP address or CIDR range.`);
  }
}

function parseRemoteAddress(remoteAddress: string | undefined): IpAddress | undefined {
  const normalized = normalizeRemoteAddress(remoteAddress);
  if (!normalized || !ipaddr.isValid(normalized)) {
    return undefined;
  }
  return normalizeIpAddress(ipaddr.process(normalized));
}

function normalizeIpAddress(address: IpAddress): IpAddress {
  if (
    address.kind() === "ipv6" &&
    (address as { isIPv4MappedAddress: () => boolean }).isIPv4MappedAddress()
  ) {
    return (address as { toIPv4Address: () => IpAddress }).toIPv4Address();
  }
  return address;
}

function normalizeCidrBits(original: IpAddress, normalized: IpAddress, bits: number): number {
  if (original.kind() === normalized.kind()) {
    return bits;
  }
  if (original.kind() === "ipv6" && normalized.kind() === "ipv4" && bits >= 96) {
    return bits - 96;
  }
  return bits;
}

function normalizeRemoteAddress(remoteAddress: string | undefined): string | undefined {
  const trimmed = remoteAddress?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
