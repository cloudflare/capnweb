import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

async function main() {
  try {
    console.log("Getting current git hash...");
    const stdout = execSync("git rev-parse --short HEAD").toString().trim();
    console.log("Git hash:", stdout);

    const version = `0.0.0-${stdout}`;
    const packageFiles = ["./package.json"];

    const packagesDir = "./packages";
    if (fs.existsSync(packagesDir)) {
      for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const pkgPath = path.join(packagesDir, entry.name, "package.json");
          if (fs.existsSync(pkgPath)) {
            packageFiles.push(pkgPath);
          }
        }
      }
    }

    for (const pkgPath of packageFiles) {
      const packageJson = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      packageJson.version = version;
      fs.writeFileSync(pkgPath, `${JSON.stringify(packageJson, null, 2)}\n`);
      console.log(`Updated ${pkgPath} to ${version}`);
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
