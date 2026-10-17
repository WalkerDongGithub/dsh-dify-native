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
if len(p['cron'].split()) != 5: sys.exit('Only five-field cron is supported; declare an explicit minute-based schedule')
it=croniter(p['cron'],start)
slots=[]
while True:
    slot=it.get_next(datetime)
    if slot>end: break
    slots.append(slot.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'))
    if len(slots)>1000: sys.exit('More than 1000 catch-up slots: narrow the explicit start_at; nothing was silently truncated')
print(json.dumps(slots))
