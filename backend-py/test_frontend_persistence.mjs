// Unit test: mirror the persistence contract from src/contexts/TcpContext.tsx
// without running a real browser.

const ENDPOINT_STORAGE_KEY = "tcp.activeEndpoint";

// Simulated localStorage backed by a Map.
const store = new Map();
const localStorage = {
  getItem(k) {
    return store.has(k) ? store.get(k) : null;
  },
  setItem(k, v) {
    store.set(k, String(v));
  },
  removeItem(k) {
    store.delete(k);
  },
  clear() {
    store.clear();
  },
};

// Ports of helpers from TcpContext.tsx
function readStoredEndpoint() {
  try {
    const raw = localStorage.getItem(ENDPOINT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.ip && parsed.port && parsed.protocol) return parsed;
  } catch {}
  return null;
}

function writeStoredEndpoint(ep) {
  try {
    localStorage.setItem(ENDPOINT_STORAGE_KEY, JSON.stringify(ep));
  } catch {}
}

function clearStoredEndpoint() {
  try {
    localStorage.removeItem(ENDPOINT_STORAGE_KEY);
  } catch {}
}

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " -- " + detail : ""}`);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Case A: round-trip
{
  localStorage.clear();
  const ep = { ip: "10.0.0.5", port: "9999", protocol: "udp" };
  writeStoredEndpoint(ep);
  const got = readStoredEndpoint();
  assert(
    "Case A: round-trip persisted endpoint",
    deepEqual(got, ep),
    `got=${JSON.stringify(got)}`
  );
}

// Case B: cleared -> null
{
  localStorage.clear();
  const got = readStoredEndpoint();
  assert("Case B: empty store returns null", got === null, `got=${JSON.stringify(got)}`);
}

// Case C: corrupt JSON -> null, no throw
{
  localStorage.clear();
  localStorage.setItem(ENDPOINT_STORAGE_KEY, "{not valid json");
  let threw = false;
  let got;
  try {
    got = readStoredEndpoint();
  } catch (e) {
    threw = true;
  }
  assert(
    "Case C: corrupt JSON returns null without throwing",
    !threw && got === null,
    `threw=${threw} got=${JSON.stringify(got)}`
  );
}

// Case D: valid JSON missing ip
{
  localStorage.clear();
  localStorage.setItem(
    ENDPOINT_STORAGE_KEY,
    JSON.stringify({ port: "8001", protocol: "tcp" })
  );
  const got = readStoredEndpoint();
  assert(
    "Case D: missing ip field returns null",
    got === null,
    `got=${JSON.stringify(got)}`
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
