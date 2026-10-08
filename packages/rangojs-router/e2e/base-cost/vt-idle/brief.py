"""Compact timeline: only the decisive events, short fiber paths.

usage: brief.py <jsonl> [row]
"""
import json, sys, re

sys.path.insert(0, __file__.rsplit("/", 1)[0])


def lane_name(l):
    if l is None:
        return "-"
    names = {1: "SyncHydration", 2: "Sync", 8: "InputContinuous", 32: "Default"}
    out = []
    for b in range(31):
        bit = 1 << b
        if not l & bit:
            continue
        if bit in names:
            out.append(names[bit])
        elif 256 <= bit <= 2097152:
            out.append(f"Transition{b - 7}")
        elif 4194304 <= bit <= 33554432:
            out.append(f"Retry{b - 21}")
        else:
            out.append(f"bit{b}")
    return "|".join(out) or "0"


def short(p):
    if not p:
        return ""
    parts = p.split(" < ")
    parts = [re.sub(r"#(route-content-suspense|loader-boundary|suspense-loading)-\S+", r"#\1", x) for x in parts]
    return " < ".join(parts[:4])


def who(stack):
    if not stack:
        return ""
    for line in stack.split("\n")[1:]:
        if "react-dom" in line or "react_dom" in line or "/react-" in line or "react.js" in line:
            continue
        m = re.search(r"at (?:async )?(\S+)? ?\(?.*?/src/([^?):]+)[^:]*:(\d+)", line)
        if m:
            return f"{m.group(1) or '<anon>'} src/{m.group(2)}:{m.group(3)} (transformed line)"
    return ""


rows = [json.loads(l) for l in open(sys.argv[1])]
row = rows[int(sys.argv[2]) if len(sys.argv) > 2 else 0]
t0 = row["t0"]
items = [(e["t"], e) for e in row["rlog"]]
for i, v in enumerate(row["vt"]):
    items.append((v["start"], {"k": f"== document.startViewTransition #{i + 1}"}))
    if v.get("finished") is not None:
        items.append((v["finished"], {"k": f"== VT #{i + 1} finished"}))
for e in row["ev"]:
    items.append((e["t"], {"k": f"-- DOM {e['id']} {e['s']}"}))
items.sort(key=lambda x: x[0])
print(f"# {row['mode']} {row['route']} delay={row['delay']} run={row['i']} | {row['load']}")
SKIP = {"render", "vt-root", "host-insert", "attach-retry", "retry-wakeable", "startViewTransition", "vt-mutation", "commit-ready-check"}
for t, e in items:
    rel = t - t0
    if rel < -1:
        continue
    k = e["k"]
    if k in SKIP:
        continue
    if k == "schedule":
        print(f"{rel:7.1f} schedule {lane_name(e['lane'])} on {short(e['fiber']).split(' < ')[0]} by {who(e.get('stack'))}")
    elif k == "retry":
        print(f"{rel:7.1f} RETRY scheduled {lane_name(e['lane'])} on {short(e['boundary'])}")
    elif k == "ping":
        print(f"{rel:7.1f} ping {lane_name(e['lanes'])} wakeable={e['wakeable']}")
    elif k == "attach-ping":
        print(f"{rel:7.1f} suspended on {e['wakeable']} at {short(e['at'])} ({lane_name(e['lanes'])})")
    elif k == "render-exit":
        print(f"{rel:7.1f} render done {lane_name(e['lanes'])} {e['status']}")
    elif k == "throttle":
        print(f"{rel:7.1f} THROTTLE commit of {lane_name(e['lanes'])} for {e['ms']:.0f} ms")
    elif k == "commit-suspended":
        print(f"{rel:7.1f} commit of {lane_name(e['lanes'])} HELD waitingForViewTransition={e['waitingForViewTransition']}")
    elif k == "commit":
        print(f"{rel:7.1f} COMMIT {lane_name(e['lanes'])} eligible={e['eligible']} startsVT={e['startsViewTransition']} types={e['types']}")
    elif k == "vt-flag":
        print(f"{rel:7.1f}   vt-flag {e['why']} {short(e.get('fiber') or e.get('host'))}")
    elif k == "vt-before-update":
        print(f"{rel:7.1f}   <ViewTransition> on commit path, update class={e.get('className', 'auto (unset)')}")
    elif k == "vt-after-update":
        print(f"{rel:7.1f}   after mutation: updateFlag={e['updateFlag']} animates={e['animates']}")
    elif k == "fallback-toggle":
        print(f"{rel:7.1f}   fallback {'shown' if e['showsFallback'] else 'removed'} on {short(e['boundary']).split(' < ')[0]}")
    else:
        extra = " ".join(f"{a}={b}" for a, b in e.items() if a not in ("k", "t", "stack"))
        print(f"{rel:7.1f} {k} {extra}")
