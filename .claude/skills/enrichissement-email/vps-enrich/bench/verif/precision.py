import csv,re,sys,glob,collections,unicodedata
norm=lambda s: re.sub(r'[^a-z0-9]+',' ',unicodedata.normalize('NFD',s or '').encode('ascii','ignore').decode().lower()).strip()
SRC=sys.argv[1] if len(sys.argv)>1 else '/home/ubuntu/enrich/bench/resolved-pilot-200.csv'
pilot={norm(r['nom']):r for r in csv.DictReader(open(SRC,encoding='utf-8-sig'),delimiter=';')}
verd={}
for f in sorted(glob.glob(sys.argv[2] if len(sys.argv)>2 else '/home/ubuntu/enrich/bench/verif/lot-*.result.md')):
    for line in open(f,encoding='utf-8'):
        m=re.match(r'^\|\s*(.+?)\s*\|\s*(OK|VARIANTE|FAUX|INCONNU)\s*\|',line,re.I)
        if m: verd[norm(m.group(1).replace('&amp;','&'))]=m.group(2).upper()
groups={'ÉCRITS par le résolveur (fort/moyen, MX)':[],'DIFFÉRÉS (faible/aucun, non écrits)':[]}
for k,r in pilot.items():
    if k not in verd: continue
    written = r['niveau'] in ('fort','moyen') and r['mx']=='oui'
    groups['ÉCRITS par le résolveur (fort/moyen, MX)' if written else 'DIFFÉRÉS (faible/aucun, non écrits)'].append(verd[k])
print(f"verdicts rapprochés : {sum(len(v) for v in groups.values())} / {len(verd)} lus (lots : {len(glob.glob(sys.argv[2] if len(sys.argv)>2 else '/home/ubuntu/enrich/bench/verif/lot-*.result.md'))})")
for g,vs in groups.items():
    c=collections.Counter(vs); n=len(vs) or 1
    bonne=c['OK']+c['VARIANTE']
    print(f"{g} : {len(vs)} → OK {c['OK']} · VARIANTE {c['VARIANTE']} · FAUX {c['FAUX']} · INCONNU {c['INCONNU']}  ⇒ bonne entreprise {bonne}/{len(vs)} = {round(100*bonne/n)} % · exact {round(100*c['OK']/n)} %")
