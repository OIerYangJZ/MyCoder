#!/bin/bash
# Drive the real CLI through a real pty (ADR-0032, risk 1).
#
# Kept as a script rather than a test because it needs a pty, and allocating one
# without a dependency means `script(1)` — which is a platform tool, not something
# `node --test` can arrange. Run it by hand: `bash tests/live/editor-pty.sh`.
#
# It is the check that found the Ctrl-C regression the 46 unit tests did not: both
# Ctrl-C and Ctrl-D resolved to the same value, so Ctrl-C exited the program.
#
# `script` allocates one; the earlier attempt failed because printf closed stdin
# immediately and the editor had nothing to read. Keeping the feeder alive with
# sleeps is what makes the keystrokes arrive while raw mode is on.
set -u
cd /Users/yangjinsey/MyCoder/kernel
rm -rf /tmp/pty-ws && mkdir -p /tmp/pty-ws/src
printf 'export const marker = "PTY-FILE-MARKER";\n' > /tmp/pty-ws/src/thing.ts
ESC=$(printf '\033')

{
  sleep 2
  printf '修复宽度'          # CJK, four characters, eight columns
  sleep 1
  printf "%s[D%s[D" "$ESC" "$ESC"   # left twice
  sleep 1
  printf 'XY'                # insert mid-string
  sleep 1
  printf '\003'              # Ctrl-C: abandon the CJK line
  sleep 1
  printf '/s\t'              # on a fresh line: two candidates, so a menu
  sleep 1
  printf '\003'              # abandon that too
  sleep 1
  printf '/status\r'         # a real control command
  sleep 3
  printf 'look at @src/th'    # an @ reference, completed with Tab
  sleep 1
  printf '\t'
  sleep 1
  printf '\r'               # send it, so the file is attached
  sleep 4
  printf '\004'              # Ctrl-D: exit
  sleep 3
} | script -q /dev/null node src/cli/main.ts --cwd /tmp/pty-ws > /tmp/pty.raw 2>&1

echo "exit=$?"


# The viewport: a paste taller than the window, in a window made small on purpose.
# `stty rows` inside the pty is what makes this a real test rather than a unit one.
{
  sleep 2
  printf '%s[200~' "$ESC"
  for i in $(seq 1 40); do printf 'pasted line %s\n' "$i"; done
  printf '%s[201~' "$ESC"
  sleep 2
  printf '\003'
  sleep 1
  printf '\004'
  sleep 2
} | script -q /dev/null /bin/sh -c 'stty rows 12 cols 60; exec node src/cli/main.ts --cwd /tmp/pty-ws' > /tmp/pty-tall.raw 2>&1
node -e '
const fs = require("fs");
const raw = fs.readFileSync("/tmp/pty.raw", "utf8");
const E = String.fromCharCode(27);
const checks = [
  ["bracketed paste on, and off again", raw.includes(E + "[?2004h") && raw.includes(E + "[?2004l")],
  ["CJK insertion landed mid-string", raw.includes("修复XY宽度")],
  ["Ctrl-C abandoned the line without exiting", raw.includes("修复XY宽度") && /\/skills/.test(raw)],
  ["completion menu showed both candidates", /\/skills/.test(raw) && /\/status/.test(raw)],
  ["selection marker in the menu", raw.includes("❯")],
  ["a control command ran to completion", /isolation|profile|permission/i.test(raw)],
  // The input is inside a box now, not under a rule. Both corners have to be on
  // screen: a top drawn without a bottom is what a frame looks like when the row
  // count and the drawing have stopped agreeing.
  ["the input box is drawn, both corners", raw.includes("╭") && raw.includes("╰")],
  ["@ completion filled in the path", /@src\/thing\.ts/.test(raw)],
  ["the attachment was reported", /attached src\/thing\.ts/.test(raw)],
  ["a paste taller than the window never moves up more rows than the window has",
   (() => {
     const tall = fs.readFileSync("/tmp/pty-tall.raw", "utf8");
     const ups = [...tall.matchAll(new RegExp(E + "\\[(\\d+)A", "g"))].map((m) => Number(m[1]));
     return ups.length > 0 && Math.max(...ups) < 12;
   })()],
  ["and the paste is still what was pasted, not submitted line by line",
   /pasted line 40/.test(fs.readFileSync("/tmp/pty-tall.raw", "utf8"))],
  // The editor takes its own block down before the marked line replaces it.
  // Without this the prompt line survived and the sent line appeared twice: once
  // as typed, once as the block. This used to look for the `47;30` slab, which is
  // gone — the sent line is a `❯` in the margin now.
  //
  // The take-down is `\r`, then up by the row the cursor is on, then erase to the
  // end of the screen. The row is 1 rather than 0 now — the box has a top border
  // above the prompt — so the move is part of what is matched here.
  ["the sent line replaced its prompt rather than stacking under it",
   (() => {
     const found = [...raw.matchAll(/❯[^\n]{0,40}\/status/g)];
     const at = found.length > 0 ? found[found.length - 1].index : -1;
     if (at <= 0) return false;
     const before = raw.slice(Math.max(0, at - 64), at);
     return new RegExp("\\r(" + E + "\\[\\d+A)?" + E + "\\[J").test(before);
   })()],
];
let bad = 0;
for (const [what, pass] of checks) {
  if (!pass) bad += 1;
  console.log((pass ? "  ok   " : "  FAIL ") + what);
}
process.exitCode = bad === 0 ? 0 : 1;
'
