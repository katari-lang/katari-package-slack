// The `slack` and `discord` packages are TWINS: the same data types with the same fields, and the same
// agents with the same argument names, so a bot ports between them by swapping the import. That contract
// used to live in prose, in three places — this module's header, this README, and the discord README —
// and by 2026-07 all three were stale and disagreed (two divergences, five, and six). A contract nothing
// checks is a contract that drifts, and the drift was silent: `try_send` changed shape on one side only,
// `limits` / `check_controls` (and the since-returned `author_tag`) were added to one side only, and
// `deliver_to`'s argument was named differently on both twins than on every other watch in the ecosystem.
//
// So the contract is a MACHINE now. This script reads both modules and compares their published surfaces:
// every name, every data field, every agent argument, every type synonym's members. Anything that differs
// must be DECLARED below, with a reason — and the declarations are the single source of truth the README's
// "Divergences" table narrates. Adding a field to one side fails here, until it is either added to the
// other or written down as a divergence.
//
// It also holds the twins to what they GAVE BACK. `fit_message` and `author_tag` were the same judgement
// written twice here and are now the prelude's `string.fit` / `crypto.pseudonym`; a twin that grows either
// of them again would be a third copy, and — because the two sides would grow it TOGETHER, to stay twins —
// the symmetric comparison above would not notice. RETURNED is the list that does.
//
// It is not a type checker and does not need to be: `katari check` already proves each module internally.
// What it proves is the thing no compiler can see — that two independently published packages still
// describe the same shape.
//
// Both files are read as TEXT. There is no Katari parser to reach for here, and the surface this compares
// (top-level declarations) is exactly the part that is unambiguous at column 0.
//
// The twin lives in a SEPARATE repository. In the working tree the two are checked out side by side under
// `katari-packages/`, which is where this runs; a lone checkout of this package has nothing to compare
// against and says so rather than failing. Point `KATARI_DISCORD_KTR` at the twin to run it elsewhere.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const slackPath = join(packageRoot, "src", "slack.ktr");
const discordPath = process.env.KATARI_DISCORD_KTR ?? join(packageRoot, "..", "discord", "src", "discord.ktr");

// ── the declared divergences: the twin contract's single source of truth ─────────────────────────

/** Two names that ARE each other's twin despite reading differently. Their members / fields / arguments
 *  are compared as though they shared a name. */
const ALIASES = [
  {
    slack: "slack_error",
    discord: "discord_error",
    why: "each package names its own failure sum, and an app catches the one it imported; the two constructors under it are identical",
  },
];

/** A declaration, field or argument that exists on ONE side only, and why. `path` is `name` for a
 *  top-level declaration, `name.member` for a data field, an agent argument or a type synonym member. */
const ONLY = [
  {
    side: "slack",
    path: "message.thread",
    why: "Slack addresses a thread by its parent's `ts`, which is also a message's identity; Discord has no such value, so there is nothing for the twin to carry",
  },
  {
    side: "slack",
    path: "send_message.thread_ts",
    why: "the other half of `message.thread` — a delivered thread passed straight back replies where the message came from",
  },
  {
    side: "slack",
    path: "try_send.thread_ts",
    why: "as `send_message.thread_ts`",
  },
  {
    side: "slack",
    path: "provider.bot_source",
    why: "Slack genuinely takes two credentials (the `xoxb-…` Web API token and the `xapp-…` socket token); Discord's gateway takes one, which its provider names `source`",
  },
  {
    side: "slack",
    path: "provider.app_source",
    why: "as `provider.bot_source`",
  },
  {
    side: "slack",
    path: "credential_data",
    why: "the resolved counterpart of `provider.bot_source` + `provider.app_source`: `credential` has to serve a PAIR here, so the pair needs a name, where the Discord twin's single gateway token is served as the `string of private` itself",
  },
  {
    side: "slack",
    path: "caps.post_text",
    why: "Slack caps a posted message's text (40000, TRUNCATED) separately from a block's text (3000, FATAL), so the two planes need two numbers; Discord's single 2000 governs both, so its `caps` has one",
  },
  {
    side: "discord",
    path: "provider.source",
    why: "the single gateway token; the Slack twin needs two, named `bot_source` / `app_source`",
  },
  {
    side: "discord",
    path: "message.display_name",
    why: "Discord's MESSAGE_CREATE ships a partial guild member beside the author, so the nickname → global name → username chain costs nothing; Slack's message event carries only the `U…` id, so the same field there is a `users.info` call per message plus the `users:read` scope — an asymmetry in what each platform hands you",
  },
  {
    side: "discord",
    path: "clicked.display_name",
    why: "as `message.display_name`, on the interaction plane",
  },
  {
    side: "discord",
    path: "chose.display_name",
    why: "as `message.display_name`, on the interaction plane",
  },
  {
    side: "discord",
    path: "submitted.display_name",
    why: "as `message.display_name`, on the interaction plane",
  },
];

/** Names both twins RETURNED to the prelude — a judgement that was written twice here, once per platform,
 *  and is now written once for everyone. Neither side may publish one again: a re-grown copy would be a
 *  THIRD implementation of the arithmetic (`fit_message` overshot its own cap by the marker's length on
 *  both sides before this) or of the security choice (`author_tag`'s keying, which the composition that
 *  reaches for `sha256` gets wrong silently). The symmetric comparison above cannot catch it, because a
 *  twin re-grows a name on BOTH sides to stay a twin — so it is caught here, by name. */
const RETURNED = [
  {
    name: "fit_message",
    to: "string.fit",
    why: "cut-and-say-so is one arithmetic; the cap the platform enforces still comes from this package's `limits()`",
  },
  {
    name: "author_tag",
    to: "crypto.pseudonym",
    why: "the keyed-HMAC choice belongs where every package can reach it; resolve the key with `credentials.resolve` at the call site",
  },
];

/** Externals are the low-level FFI seam, named for the platform they call (`slack_send` / `discord_send`)
 *  and not part of the twin surface — every one of them is fronted by an agent that is. They are skipped
 *  wholesale rather than listed. */
const COMPARE_EXTERNALS = false;

// ── reading a module's published surface ─────────────────────────────────────────────────────────

const problems = [];

/** Doc strings are prose and may contain anything — `data`, `agent`, a colon at the start of a line — so
 *  they come out before any structure is read. `@"…"` with backslash escapes, spanning lines. */
function withoutDocs(source) {
  return source.replace(/@"(?:[^"\\]|\\[\s\S])*"/g, "");
}

/** From `at`, which must index an opening bracket, the index just past its match. Counts `(`, `[` and `{`
 *  together: an argument's type may carry any of them (`array[file]`, `{...E, connection}`). */
function closingIndex(text, at) {
  const opens = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let index = at; index < text.length; index += 1) {
    const char = text[index];
    if (opens[char] !== undefined) stack.push(opens[char]);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

/** A bracketed list's top-level entries: split on commas at depth zero, so a nested `agent (value: null)`
 *  or a `{...E, connection}` row stays inside the entry that owns it. */
function topLevelEntries(inside) {
  const entries = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inside.length; index += 1) {
    const char = inside[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      entries.push(inside.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(inside.slice(start));
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/** Each entry's own name, and — when the entry is a CALLBACK — the argument names that callback is called
 *  with. The second half matters as much as the first: `deliver_to`'s own name matched across the twins
 *  for months while one called it with `message =` and the other would have wanted `value =`, so a
 *  handler written for one watch could not be handed to the other. Names are structural; a callback's
 *  argument name is part of the contract its caller publishes. */
function memberEntries(inside) {
  const members = [];
  for (const entry of topLevelEntries(inside)) {
    const named = entry.match(/^([a-z_][A-Za-z0-9_]*)\s*:/);
    if (named === null) continue;
    const callback = entry.match(/\bagent\s*(?:\[[^\]]*\])?\s*\(/);
    if (callback === null) {
      members.push({ name: named[1], callback: null });
      continue;
    }
    const open = callback.index + callback[0].length - 1;
    const close = closingIndex(entry, open);
    members.push({
      name: named[1],
      callback: close === -1 ? null : memberEntries(entry.slice(open + 1, close - 1)).map((inner) => inner.name),
    });
  }
  return members;
}

const namesOf = (members) => members.map((member) => member.name);

/** One module's published surface: `{ kind, members }` per top-level name. `members` is the field list of
 *  a `data`, the argument list of an `agent` / `request`, or the constructor list of a `type`. */
function surfaceOf(path, label) {
  const source = withoutDocs(readFileSync(path, "utf8"));
  const surface = new Map();

  // `data name( … )` — the fields, in declaration order.
  for (const match of source.matchAll(/^data ([a-z_][A-Za-z0-9_]*)\(/gm)) {
    const open = match.index + match[0].length - 1;
    const close = closingIndex(source, open);
    if (close === -1) {
      problems.push(`${label}: \`data ${match[1]}(\` is never closed`);
      continue;
    }
    surface.set(match[1], { kind: "data", members: memberEntries(source.slice(open + 1, close - 1)) });
  }

  // `type name = a | b | c` — the constructors, sorted (a sum's order is not part of its contract).
  for (const match of source.matchAll(/^type ([a-z_][A-Za-z0-9_]*)\s*=\s*([^\n]+)/gm)) {
    const members = match[2].split("|").map((member) => member.trim()).filter((member) => member !== "");
    surface.set(match[1], { kind: "type", members: members.sort().map((member) => ({ name: member, callback: null })) });
  }

  // `agent name[generics]( … )` and `request name( … )` — the argument names, in declaration order.
  // Anchored at column 0, which is what makes the nested agents inside a body invisible here.
  for (const match of source.matchAll(/^(external agent|agent|request) ([a-z_][A-Za-z0-9_]*)\s*(\[[^\]]*\])?\(/gm)) {
    const [, keyword, name] = match;
    if (keyword === "external agent" && !COMPARE_EXTERNALS) continue;
    const open = match.index + match[0].length - 1;
    const close = closingIndex(source, open);
    if (close === -1) {
      problems.push(`${label}: \`${keyword} ${name}(\` is never closed`);
      continue;
    }
    surface.set(name, { kind: keyword === "request" ? "request" : "agent", members: memberEntries(source.slice(open + 1, close - 1)) });
  }

  return surface;
}

// ── the comparison ───────────────────────────────────────────────────────────────────────────────

if (!existsSync(discordPath)) {
  console.log(
    `SKIPPED: the discord twin is not checked out at ${discordPath}.\n` +
      `The twin contract is checked where both packages sit side by side (katari-packages/), or with\n` +
      `KATARI_DISCORD_KTR pointing at the twin's discord.ktr. Nothing was compared.`,
  );
  process.exit(0);
}

const slack = surfaceOf(slackPath, slackPath);
const discord = surfaceOf(discordPath, discordPath);

const aliasOf = { slack: new Map(), discord: new Map() };
for (const alias of ALIASES) {
  aliasOf.slack.set(alias.slack, alias.discord);
  aliasOf.discord.set(alias.discord, alias.slack);
}

/** Every declared one-sided path, and whether the run used it — an obsolete declaration is a stale note
 *  about a divergence that no longer exists, which is the thing this script exists to stop. */
const declared = new Map(ONLY.map((only) => [`${only.side}:${only.path}`, { ...only, used: false }]));

function isDeclared(side, path) {
  const entry = declared.get(`${side}:${path}`);
  if (entry === undefined) return false;
  entry.used = true;
  return true;
}

/** The twin's name for one side's declaration, following an alias where there is one. */
function twinName(side, name) {
  return aliasOf[side].get(name) ?? name;
}

// Names on one side and not the other.
for (const [side, own, other] of [
  ["slack", slack, discord],
  ["discord", discord, slack],
]) {
  for (const name of own.keys()) {
    if (other.has(twinName(side, name))) continue;
    if (isDeclared(side, name)) continue;
    problems.push(
      `${side} publishes \`${name}\` and its twin does not. Either give the twin one, or declare it in` +
        ` ONLY as { side: "${side}", path: "${name}", why: … } — a surface only one twin has is the` +
        ` divergence a porting bot trips over.`,
    );
  }
}

// Names that went back to the prelude, on either side.
for (const returned of RETURNED) {
  for (const [side, own] of [["slack", slack], ["discord", discord]]) {
    if (!own.has(returned.name)) continue;
    problems.push(
      `${side} publishes \`${returned.name}\` again, which both twins returned to the prelude as` +
        ` \`${returned.to}\` — ${returned.why}. Call the prelude's, or, if this package really does owe` +
        ` the ecosystem a judgement the prelude does not carry, delete the entry from RETURNED and say` +
        ` what changed.`,
    );
  }
}

// Members of the names both sides publish.
for (const [name, entry] of slack) {
  const twin = twinName("slack", name);
  const other = discord.get(twin);
  if (other === undefined) continue;
  const shown = twin === name ? name : `${name} / ${twin}`;

  if (entry.kind !== other.kind) {
    problems.push(`\`${shown}\` is a ${entry.kind} in slack and a ${other.kind} in discord`);
    continue;
  }

  for (const [side, members, otherMembers, ownName] of [
    ["slack", entry.members, other.members, name],
    ["discord", other.members, entry.members, twin],
  ]) {
    for (const member of members) {
      if (namesOf(otherMembers).includes(member.name)) continue;
      if (isDeclared(side, `${ownName}.${member.name}`)) continue;
      const what = entry.kind === "data" ? "field" : entry.kind === "type" ? "constructor" : "argument";
      problems.push(
        `\`${shown}\`: ${side} has the ${what} \`${member.name}\` and its twin does not. Argument and` +
          ` field names are STRUCTURAL in Katari — a caller passes them by name — so this is a program` +
          ` that compiles against one twin and not the other. Add it there, or declare it in ONLY as` +
          ` { side: "${side}", path: "${ownName}.${member.name}", why: … }.`,
      );
    }
  }

  // A CALLBACK argument the twins share: the names it is CALLED with must match too, or a handler written
  // for one cannot be handed to the other. This is the check that was missing when `deliver_to` drifted.
  for (const member of entry.members) {
    if (member.callback === null) continue;
    const twinMember = other.members.find((candidate) => candidate.name === member.name);
    if (twinMember === undefined || twinMember.callback === null) continue;
    if (member.callback.join(",") === twinMember.callback.join(",")) continue;
    problems.push(
      `\`${shown}\`: the callback \`${member.name}\` is called with (${member.callback.join(", ")}) in` +
        ` slack and (${twinMember.callback.join(", ")}) in discord. A callback's argument names are part` +
        ` of the contract its caller publishes, so the same handler cannot be passed to both. The` +
        ` prelude's primary argument is \`value\`.`,
    );
  }

  // Order matters for reading, not for calling; report it as its own problem so a rename is not confused
  // with a reshuffle. Only the shared members are compared, since the one-sided ones are declared.
  if (entry.kind !== "type") {
    const sharedSlack = namesOf(entry.members).filter((member) => namesOf(other.members).includes(member));
    const sharedDiscord = namesOf(other.members).filter((member) => namesOf(entry.members).includes(member));
    if (sharedSlack.join(",") !== sharedDiscord.join(",")) {
      problems.push(
        `\`${shown}\`: the shared members are in a different order — slack has [${sharedSlack.join(", ")}]` +
          ` and discord has [${sharedDiscord.join(", ")}]. The twins are read side by side; keep them aligned.`,
      );
    }
  }
}

for (const [key, entry] of declared) {
  if (entry.used) continue;
  problems.push(
    `ONLY still declares ${key} ("${entry.why}"), but nothing in the modules matches it. The divergence` +
      ` is gone or was renamed — delete the declaration, so the list stays the list.`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`${problem}\n`);
  console.error(
    `${problems.length} problem(s). The slack and discord packages are twins by contract: the same data` +
      ` with the same fields and the same agents with the same argument names. This script is the only` +
      ` thing that holds the two published surfaces to it.`,
  );
  process.exit(1);
}

// ── the report: the declared divergences, and the envelope a portable program writes to ──────────

console.log(
  `the twin contract holds: ${slack.size} published name(s) on the slack side, ${discord.size} on the` +
    ` discord side, ${ONLY.length} declared divergence(s), ${ALIASES.length} alias(es),` +
    ` ${RETURNED.length} name(s) returned to the prelude and still gone.\n`,
);

console.log("Returned to the prelude (neither twin may publish these again):");
for (const returned of RETURNED) {
  console.log(`  both     ${returned.name} → ${returned.to} — ${returned.why}`);
}
console.log("");

console.log("Declared divergences (the source the README's table narrates):");
for (const alias of ALIASES) {
  console.log(`  both   ${alias.slack} / ${alias.discord} — ${alias.why}`);
}
for (const only of ONLY) {
  console.log(`  ${only.side.padEnd(9)}${only.path} — ${only.why}`);
}

// A control that must render on BOTH platforms is written to the tighter of each pair. Neither package
// can enforce that (each knows only its own platform), so the envelope is DERIVED here from the two
// published `caps` and printed — the twin contract's numeric half, computed rather than hand-copied.
function capsOf(path) {
  const source = readFileSync(path, "utf8");
  const block = source.match(/agent limits\(\) -> caps \{\s*caps\(([\s\S]*?)\n\s*\)\n\}/);
  if (block === null) return null;
  const values = {};
  for (const match of block[1].matchAll(/^\s*([a-z][a-z0-9_]*) = (\d+),/gm)) values[match[1]] = Number(match[2]);
  return values;
}

const slackCaps = capsOf(slackPath);
const discordCaps = capsOf(discordPath);
if (slackCaps !== null && discordCaps !== null) {
  console.log("\nThe portable envelope — the tighter of each pair, which a control rendering on both fits:");
  for (const field of Object.keys(slackCaps)) {
    if (discordCaps[field] === undefined) continue;
    const tighter = Math.min(slackCaps[field], discordCaps[field]);
    const from = slackCaps[field] === discordCaps[field] ? "both" : slackCaps[field] < discordCaps[field] ? "slack" : "discord";
    console.log(`  ${field.padEnd(16)}${String(tighter).padStart(6)}   (slack ${slackCaps[field]}, discord ${discordCaps[field]} — ${from})`);
  }
  console.log(
    "  (`rows` and `buttons_per_row` are LAYOUT RULES, not lengths, and the two platforms' rules differ:\n" +
      "   Slack packs every control into one actions row, Discord packs buttons 5 to a row and gives each\n" +
      "   dropdown a row of its own. Read that pair as the pair, not as a minimum.)",
  );
}
