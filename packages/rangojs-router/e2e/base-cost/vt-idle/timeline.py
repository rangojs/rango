"""Print one merged timeline per recorded row of vt-trace.spec.ts.

usage: timeline.py <jsonl> [row-index] [--stacks]
"""
import json, sys, re

LANES = {
    1: "SyncHydration", 2: "Sync", 4: "InputContinuousHydration", 8: "InputContinuous",
    16: "DefaultHydration", 32: "Default", 64: "Gesture", 128: "TransitionHydration",
    268435456: "Idle", 536870912: "Offscreen", 1073741824: "Deferred",
}


def lane_name(l):
    if l is None:
        return "-"
    out = []
    for b in range(31):
        bit = 1 << b
        if not l & bit:
            continue
        if bit in LANES:
            out.append(LANES[bit])
        elif 256 <= bit <= 2097152:
            out.append(f"Transition{b - 7}")
        elif 4194304 <= bit <= 33554432:
            out.append(f"Retry{b - 21}")
        else:
            out.append(f"bit{b}")
    return "|".join(out) or "0"


def short_stack(stack, n=7):
    if not stack:
        return ""
    frames = []
    for line in stack.split("\n")[1:]:
        m = re.search(r"at (?:async )?([^\s(]+)? ?\(?(?:https?://[^/]+)?([^)]*)\)?", line)
        if not m:
            continue
        fn, loc = m.group(1) or "<anon>", m.group(2)
        loc = re.sub(r"\?[^:]*", "", loc)
        loc = loc.split("/")[-1]
        if "react-dom" in loc or "react_dom" in loc or "chunk-" in loc and fn in ("scheduleUpdateOnFiber",):
            if fn in ("scheduleUpdateOnFiber", "__rl"):
                continue
        frames.append(f"{fn}@{loc}")
    return " <- ".join(frames[:n])


def main():
    rows = [json.loads(l) for l in open(sys.argv[1])]
    idx = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].lstrip("-").isdigit() else 0
    stacks = "--stacks" in sys.argv
    row = rows[idx]
    t0 = row["t0"]
    items = []
    for e in row["rlog"]:
        items.append((e["t"], "react", e))
    for i, v in enumerate(row["vt"]):
        items.append((v["start"], "vt", {"k": f"document.startViewTransition #{i + 1}", "stack": v.get("stack")}))
        if v.get("ready") is not None:
            items.append((v["ready"], "vt", {"k": f"VT #{i + 1} ready"}))
        if v.get("finished") is not None:
            items.append((v["finished"], "vt", {"k": f"VT #{i + 1} finished"}))
    for e in row["ev"]:
        items.append((e["t"], "dom", {"k": f"DOM {e['id']} -> {e['s']}"}))
    items.sort(key=lambda x: x[0])
    print(f"# {row['mode']} {row['route']} delay={row['delay']} run={row['i']}  load: {row['load']}")
    for t, src, e in items:
        rel = t - t0
        if rel < -1:
            continue
        k = e["k"]
        extra = []
        for key, val in e.items():
            if key in ("k", "t", "stack"):
                continue
            if key in ("lane", "lanes", "suspendedLanes", "wipLanes"):
                val = lane_name(val)
            extra.append(f"{key}={val}")
        line = f"{rel:8.1f}  {k:28s} {' '.join(extra)}"
        print(line)
        if e.get("stack") and (stacks or k == "schedule" or k.startswith("document.start")):
            print(f"{'':10s}  stack: {short_stack(e['stack'])}")


main()
