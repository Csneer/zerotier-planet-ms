'use strict';

const {isIP} = require('node:net');
const {Address4, Address6} = require('ip-address');

// Bound and classify literals before the address library parses user input.
// Zone IDs identify a host interface and do not belong in managed network data.
function family(value) {
  return typeof value === 'string' && value.length <= 45 && !value.includes('%') ? isIP(value) : 0;
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function cidr(value) {
  if (typeof value !== 'string' || value.length > 49) return null;
  const parts = value.split('/');
  if (parts.length !== 2 || !/^(0|[1-9]\d{0,2})$/.test(parts[1])) return null;
  const version = family(parts[0]);
  const prefix = Number(parts[1]);
  if (!version || prefix > (version === 4 ? 32 : 128)) return null;
  return {address: parts[0], family: version, prefix};
}

function validRoute(target, via) {
  const parsed = cidr(target);
  return Boolean(parsed && (via === null || via === '' || via === undefined || family(via) === parsed.family));
}

function validPool(start, end) {
  const version = family(start);
  if (!version || family(end) !== version) return false;
  const Address = version === 4 ? Address4 : Address6;
  return new Address(start).bigInt() <= new Address(end).bigInt();
}

function inSubnet(address, target) {
  const version = family(address);
  const subnet = cidr(target);
  if (!version || !subnet || version !== subnet.family) return false;
  const Address = version === 4 ? Address4 : Address6;
  return new Address(address).isInSubnet(new Address(target));
}

function canonicalTarget(target) {
  const parsed = cidr(target);
  if (!parsed) throw new Error('Target network must be valid CIDR format');
  return parsed.family === 6 ? new Address6(parsed.address).canonicalForm() + '/' + parsed.prefix : target;
}

function dnsServers(value) {
  if (typeof value !== 'string') return null;
  const servers = value.split('\n').map(trim).filter(Boolean);
  return servers.every(ip => family(ip)) ? servers : null;
}

module.exports = {family, trim, cidr, validRoute, validPool, inSubnet, canonicalTarget, dnsServers};
