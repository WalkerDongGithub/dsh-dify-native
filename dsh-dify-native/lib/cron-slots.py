"""Cron/timezone calculations only; no workflow or side effects."""
import json, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
try:
    from croniter import croniter
except ImportError:
    sys.exit('Missing croniter: run scripts/install-events.sh or configure DIFY_EVENTS_VENDOR / DIFY_PYTHONPATH with requirements-events.txt')
p=json.loads(sys.argv[1])
start=datetime.fromisoformat(p['after'].replace('Z','+00:00')).astimezone(ZoneInfo(p['timezone']))
end=datetime.fromisoformat(p['until'].replace('Z','+00:00'))
if not p.get('cron'):
    import importlib.util
    from pathlib import Path
    from types import SimpleNamespace
    spec=importlib.util.spec_from_file_location('schedule_parser',Path(__file__).with_name('schedule-parser.py'));parser=importlib.util.module_from_spec(spec);spec.loader.exec_module(parser)
    node=p.get('node',{})
    if node.get('mode','visual')!='visual': sys.exit('cron_expression is required for cron mode')
    visual={'on_minute':0,'time':'12:00 AM','weekdays':None,'monthly_days':None,**(node.get('visual_config') or {})}
    p['cron']=parser.visual_to_cron(node.get('frequency'),SimpleNamespace(**visual))
if len(p['cron'].split()) != 5 and not p['cron'].startswith('@'): sys.exit('Only five-field cron is supported; declare an explicit minute-based schedule')
it=croniter(p['cron'],start)
slots=[]
while True:
    slot=it.get_next(datetime)
    if slot>end: break
    slots.append(slot.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'))
    if len(slots)>1000: sys.exit('More than 1000 catch-up slots: narrow the explicit start_at; nothing was silently truncated')
print(json.dumps(slots))
