import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

export function deploymentFailures(raw) {
  const errors = [];
  const config = parse(raw, errors, { allowTrailingComma: true });
  if (
    errors.length ||
    !config ||
    typeof config !== "object" ||
    Array.isArray(config)
  )
    return ["wrangler.jsonc 格式无效，请检查配置文件。"];
  const binding = Array.isArray(config.hyperdrive)
    ? config.hyperdrive.find((value) => value?.binding === "HYPERDRIVE")
    : null;
  const failures = [];
  if (
    !binding ||
    typeof binding.id !== "string" ||
    !/^[a-f0-9]{32}$/i.test(binding.id) ||
    /^0+$/.test(binding.id)
  )
    failures.push("请填写真实的 Hyperdrive ID，并禁用该配置的查询缓存。");
  const repository = config.vars?.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    failures.push("请填写 GITHUB_REPOSITORY（owner/repository）。");
  const branch = config.vars?.GITHUB_WORKFLOW_REF;
  if (typeof branch !== "string" || !branch.trim())
    failures.push("请填写受信任默认分支 GITHUB_WORKFLOW_REF。");
  return failures;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let failures;
  try {
    failures = deploymentFailures(
      readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
    );
  } catch {
    failures = ["无法读取 wrangler.jsonc，请检查配置文件。"];
  }
  if (failures.length) {
    console.error("部署配置未完成：\n" + failures.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "部署配置占位符检查通过；Secrets 和实际连接由 Wrangler 与 doctor 验证。",
    );
}
