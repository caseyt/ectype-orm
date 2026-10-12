// Usage: node scripts/check-node-version.mjs <major> [label]
// Prints the running Node.js version and fails unless its major version is <major>.
// CI runs it in every job so that the logs show which Node the job really executed on.
const [want, label = "node"] = process.argv.slice(2);
const major = process.versions.node.split(".")[0];

if (want === undefined || major !== want) {
  console.error(`${label}: expected Node.js ${want}, got ${process.version} (${process.execPath})`);
  process.exit(1);
}
console.log(`${label}: Node.js ${process.version} (${process.execPath})`);
