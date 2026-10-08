"""What each view transition of a trace row animates.

usage: anims.py <jsonl> [row]
"""
import json, sys

rows = [json.loads(l) for l in open(sys.argv[1])]
row = rows[int(sys.argv[2]) if len(sys.argv) > 2 else 0]
t0 = row["t0"]
print(f"# {row['mode']} {row['route']} delay={row['delay']} | {row['load']}")
for i, v in enumerate(row["vt"]):
    print(f"VT #{i + 1} {v['start'] - t0:.0f}-{(v.get('finished') or 0) - t0:.0f}")
    for a in v.get("anims") or []:
        print(f"    {a['pseudo']:42s} {a['name']:36s} {a['duration']} ms opacity {a['opacity']}")
