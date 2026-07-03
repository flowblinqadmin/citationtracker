#!/usr/bin/python3.12
'''Flowblinq integration report. Cron: 0 0,6,12,18 * * * (IST).
At 00:00 IST adds the daily wrap; other runs ship the 6-hour roll-up only.
6h mail: hourly breakdown grid. Daily mail: 6h-bucket breakdown grid.
Each cell shows visits / beacons (visits = count distinct session_id;
beacons = raw row count). Pre-cliff rows have null session_id so visits
falls back to beacons there.
'''
import os, sys, subprocess, re, html, base64, smtplib, ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
NOW_IST = datetime.now(IST)
NOW_UTC = datetime.now(timezone.utc)
INCLUDE_DAILY = NOW_IST.hour == 0 or '--with-daily' in sys.argv
DRY_RUN = '--dry-run' in sys.argv or '--preview' in sys.argv

ENV_FILE = Path('/home/aditya/flowblinq/geo/.env.production.live')
LOGO_PATH = Path('/home/aditya/flowblinq/geo/scripts/ops/flowblinq-logo.gif')
TO_ADDR = 'hello@flowblinq.com'
SUBJECT = 'FlowBlinq integration report - ' + NOW_IST.strftime('%Y-%m-%d %H:%M IST')

P = dict(ink='#1A1A18', ink2='#5A5A56', ink3='#9A9A94',
         gold='#C4841D', sage='#3B7A4A', brick='#B5403A', olive='#5C6B3C',
         page='#FAFAF8', warm='#F5F3EF', card='#FAFAF8', crease='#E8E6E1')

SERIF = "'Instrument Serif',Georgia,'Times New Roman',serif"
SANS  = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
MONO  = "'JetBrains Mono',Menlo,Consolas,'Courier New',monospace"

LOGO_CID = 'flowblinq-logo@flowblinq.com'

def db_url():
    txt = ENV_FILE.read_text()
    m = re.search(r'^DATABASE_URL="?([^"\n]+)"?', txt, re.MULTILINE)
    if not m: sys.exit('DATABASE_URL not found')
    return m.group(1).strip().rstrip('\\n')

DB = db_url()

def psql(sql):
    r = subprocess.run(['psql', DB, '-t', '-A', '-F', '|', '-c', sql],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        sys.stderr.write('PSQL ERROR: ' + r.stderr + '\n')
        return []
    return [ln.split('|') for ln in r.stdout.strip().split('\n') if ln]

def safe_int(x):
    try: return int(x)
    except: return 0

def pct_change(now, prior):
    if prior == 0:
        return None if now == 0 else float('inf')
    return ((now - prior) / prior) * 100

def fmt_pct(pct):
    if pct is None: return '-'
    if pct == float('inf'): return '+inf'
    sign = '+' if pct >= 0 else ''
    return sign + ('{:.0f}'.format(pct)) + ' percent'

def fmt_num(n):
    return '{:,}'.format(n)

def visits_or_fallback(visits, beacons):
    # Pre-cliff data has null session_id, so distinct count = 0. Fall back to beacons there.
    return visits if visits > 0 else beacons

def sql_array(slugs):
    return 'ARRAY[' + ','.join("'" + s.replace("'", "''") + "'" for s in slugs) + ']'

# --- Queries ---
INTEGRATED = '''
SELECT gs.domain, gs.slug
FROM geo_sites gs
LEFT JOIN geo_page_views pv ON pv.slug = gs.slug AND pv.viewed_at > now() - interval '30 days'
GROUP BY gs.domain, gs.slug
HAVING count(pv.*) >= 10
ORDER BY count(pv.*) DESC;
'''

def per_slug_stats(slug):
    rows = psql('''
SELECT
  count(*) FILTER (WHERE viewed_at > now() - interval '6 hours'),
  count(*) FILTER (WHERE time_on_page_ms IS NULL AND viewed_at > now() - interval '6 hours'),
  count(*) FILTER (WHERE viewed_at > now() - interval '12 hours' AND viewed_at <= now() - interval '6 hours'),
  count(*) FILTER (WHERE time_on_page_ms IS NULL AND viewed_at > now() - interval '12 hours' AND viewed_at <= now() - interval '6 hours'),
  count(*) FILTER (WHERE viewed_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
  count(*) FILTER (WHERE time_on_page_ms IS NULL AND viewed_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
  count(*) FILTER (WHERE viewed_at >= date_trunc('day', (now() - interval '1 day') at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' AND viewed_at < date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
  count(*) FILTER (WHERE time_on_page_ms IS NULL AND viewed_at >= date_trunc('day', (now() - interval '1 day') at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' AND viewed_at < date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
  count(*) FILTER (WHERE viewed_at > now() - interval '7 days'),
  count(*) FILTER (WHERE time_on_page_ms IS NULL AND viewed_at > now() - interval '7 days'),
  count(*) FILTER (WHERE viewed_at > now() - interval '14 days' AND viewed_at <= now() - interval '7 days'),
  count(*) FILTER (WHERE time_on_page_ms IS NULL AND viewed_at > now() - interval '14 days' AND viewed_at <= now() - interval '7 days'),
  count(*) FILTER (WHERE viewed_at > now() - interval '30 days')
FROM geo_page_views WHERE slug = ''' + "'" + slug + "';")
    if not rows: return None
    cols = [safe_int(x) for x in rows[0]]
    h6_b, h6_v, ph6_b, ph6_v, today_b, today_v, yest_b, yest_v, d7_b, d7_v, pd7_b, pd7_v, d30_b = cols
    peak = psql("SELECT date_trunc('hour', viewed_at)::text, count(*), count(*) FILTER (WHERE time_on_page_ms IS NULL) FROM geo_page_views WHERE slug = '" + slug + "' AND viewed_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' GROUP BY 1 ORDER BY 2 DESC LIMIT 1;")
    peak_hr, peak_b, peak_v = (peak[0][0], safe_int(peak[0][1]), safe_int(peak[0][2])) if peak else ('-', 0, 0)
    return dict(
        h6_b=h6_b, h6_v=visits_or_fallback(h6_v, h6_b),
        ph6_b=ph6_b, ph6_v=visits_or_fallback(ph6_v, ph6_b),
        today_b=today_b, today_v=visits_or_fallback(today_v, today_b),
        yest_b=yest_b, yest_v=visits_or_fallback(yest_v, yest_b),
        d7_b=d7_b, d7_v=visits_or_fallback(d7_v, d7_b),
        pd7_b=pd7_b, pd7_v=visits_or_fallback(pd7_v, pd7_b),
        d30_b=d30_b,
        peak_hr=peak_hr, peak_b=peak_b, peak_v=visits_or_fallback(peak_v, peak_b),
        avg_d_b=(d30_b/30.0 if d30_b else 0))

def hourly_grid(slugs):
    if not slugs: return [], {}
    rows = psql('''
SELECT slug,
       to_char(date_trunc('hour', viewed_at at time zone 'UTC' at time zone 'Asia/Kolkata'), 'HH24:00') AS hr,
       count(*) as beacons,
       count(*) FILTER (WHERE time_on_page_ms IS NULL) as visits
FROM geo_page_views
WHERE slug = ANY(''' + sql_array(slugs) + ''')
  AND viewed_at > now() - interval '6 hours'
GROUP BY 1, 2;
''')
    buckets = []
    for h in range(5, -1, -1):
        b = (NOW_IST - timedelta(hours=h)).replace(minute=0, second=0, microsecond=0)
        buckets.append(b.strftime('%H:00'))
    table = {s: {b: (0, 0) for b in buckets} for s in slugs}
    for r in rows:
        slug, hr, b_count, v_count = r[0], r[1], safe_int(r[2]), safe_int(r[3])
        if slug in table and hr in table[slug]:
            table[slug][hr] = (visits_or_fallback(v_count, b_count), b_count)
    return buckets, table

def six_hour_grid_yesterday(slugs):
    if not slugs: return [], {}
    rows = psql('''
WITH y AS (
  SELECT (date_trunc('day', now() at time zone 'Asia/Kolkata') - interval '1 day') AT TIME ZONE 'Asia/Kolkata' AS y_start
)
SELECT slug,
  CASE
    WHEN viewed_at < y.y_start + interval '6 hours'  THEN '00-06'
    WHEN viewed_at < y.y_start + interval '12 hours' THEN '06-12'
    WHEN viewed_at < y.y_start + interval '18 hours' THEN '12-18'
    ELSE '18-24'
  END AS bucket,
  count(*) as beacons,
  count(*) FILTER (WHERE time_on_page_ms IS NULL) as visits
FROM geo_page_views, y
WHERE slug = ANY(''' + sql_array(slugs) + ''')
  AND viewed_at >= y.y_start
  AND viewed_at <  y.y_start + interval '24 hours'
GROUP BY slug, bucket;
''')
    buckets = ['00-06', '06-12', '12-18', '18-24']
    table = {s: {b: (0, 0) for b in buckets} for s in slugs}
    for r in rows:
        slug, bucket, b_count, v_count = r[0], r[1], safe_int(r[2]), safe_int(r[3])
        if slug in table and bucket in table[slug]:
            table[slug][bucket] = (visits_or_fallback(v_count, b_count), b_count)
    return buckets, table

def alerts_for(domain, s):
    out = []
    if s['h6_v'] == 0 and s['ph6_v'] > 0:
        out.append(('brick', domain + ': zero visits last 6 hours (prior 6 hours had ' + fmt_num(s['ph6_v']) + ')'))
    elif s['ph6_v'] > 0:
        change = pct_change(s['h6_v'], s['ph6_v'])
        if change is not None and change <= -50:
            out.append(('brick', domain + ': visits down ' + str(int(abs(change))) + ' percent versus prior 6 hours (' + fmt_num(s['h6_v']) + ' versus ' + fmt_num(s['ph6_v']) + ')'))
        elif change is not None and change >= 200:
            out.append(('gold', domain + ': visits up ' + str(int(change)) + ' percent versus prior 6 hours (' + fmt_num(s['h6_v']) + ' versus ' + fmt_num(s['ph6_v']) + ')'))
    return out

def signups():
    return psql('''
SELECT gs.domain, gs.slug, gs.owner_email,
       COALESCE(gs.email_verified::text, 'false'),
       COALESCE(gs.pipeline_status, 'pending'),
       gs.created_at::text
FROM geo_sites gs
WHERE gs.created_at > now() - interval '24 hours'
ORDER BY gs.created_at DESC LIMIT 50;
''')

# --- HTML helpers ---
def th(label, align='left'):
    return '<th style="text-align:' + align + ';padding:10px 14px;font-family:' + SANS + ';font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:' + P['ink2'] + ';border-bottom:1px solid ' + P['crease'] + ';">' + html.escape(label) + '</th>'

def td(content, align='left', mono=False, color=None):
    fam = MONO if mono else SANS
    col = color or P['ink']
    return '<td style="padding:10px 14px;font-family:' + fam + ';font-size:13px;color:' + col + ';text-align:' + align + ';border-bottom:1px solid ' + P['crease'] + ';">' + content + '</td>'

def cell_vb(visits, beacons, align='right'):
    # Two-line cell: visits primary, beacons in muted color below
    primary = '<span style="color:' + P['ink'] + ';font-weight:500;">' + fmt_num(visits) + '</span>'
    secondary = '<span style="color:' + P['ink3'] + ';font-size:11px;">' + fmt_num(beacons) + ' beacons</span>'
    content = primary + '<br/>' + secondary
    return '<td style="padding:10px 14px;font-family:' + MONO + ';font-size:13px;text-align:' + align + ';border-bottom:1px solid ' + P['crease'] + ';line-height:1.4;">' + content + '</td>'

def section_title(text):
    return '<h2 style="font-family:' + SERIF + ';font-size:22px;font-weight:400;color:' + P['ink'] + ';margin:32px 0 12px 0;letter-spacing:-0.01em;">' + html.escape(text) + '</h2>'

def render_breakdown(buckets, table, slug_to_domain, label):
    parts = [section_title(label)]
    parts.append('<div style="font-family:' + SANS + ';font-size:11px;color:' + P['ink2'] + ';margin-bottom:10px;">Each cell shows <strong style="color:' + P['ink'] + ';">visits</strong> on top, <span style="color:' + P['ink3'] + ';">beacons</span> below. Visits count distinct page views (initial-load events). Beacons include engagement events from tab-hide.</div>')
    parts.append('<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + P['crease'] + ';border-collapse:collapse;">')
    header = '<tr style="background:' + P['warm'] + ';">' + th('Site')
    for b in buckets:
        header += th(b, 'right')
    header += '</tr>'
    parts.append(header)
    for slug, domain in slug_to_domain.items():
        cols = td(html.escape(domain))
        for b in buckets:
            v, bc = table[slug][b]
            cols += cell_vb(v, bc)
        parts.append('<tr>' + cols + '</tr>')
    parts.append('</table>')
    return ''.join(parts)

def build():
    integrated = psql(INTEGRATED)
    rows_data = []
    all_alerts = []
    slug_to_domain = {}
    for r in integrated:
        domain, slug = r[0], r[1]
        s = per_slug_stats(slug)
        if not s: continue
        rows_data.append((domain, slug, s))
        slug_to_domain[slug] = domain
        all_alerts.extend(alerts_for(domain, s))

    parts = []
    parts.append('<!DOCTYPE html><html><body style="margin:0;padding:0;background:' + P['warm'] + ';font-family:' + SANS + ';color:' + P['ink'] + ';">')
    parts.append('<table width="100%" cellpadding="0" cellspacing="0" style="background:' + P['warm'] + ';padding:32px 0;"><tr><td align="center">')
    parts.append('<table width="720" cellpadding="0" cellspacing="0" style="background:' + P['card'] + ';border:1px solid ' + P['crease'] + ';border-radius:6px;padding:32px 36px;"><tr><td>')

    parts.append('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border-collapse:collapse;"><tr>''<td style="vertical-align:middle;padding:0 16px 0 0;line-height:1;">''<img src="cid:' + LOGO_CID + '" width="48" height="48" alt="FlowBlinq" style="display:block;border:0;" />''</td>''<td style="vertical-align:middle;line-height:1;">''<div style="color:' + P['gold'] + ';font-family:' + SANS + ';font-size:20px;font-weight:600;letter-spacing:6px;text-transform:uppercase;line-height:1;">Flowblinq</div>''</td>''</tr></table>')
    parts.append('<h1 style="font-family:' + SERIF + ';font-size:28px;font-weight:400;color:' + P['ink'] + ';margin:6px 0 4px 0;letter-spacing:-0.01em;">Integration report</h1>')
    parts.append('<div style="font-family:' + MONO + ';font-size:11px;color:' + P['ink3'] + ';letter-spacing:0.04em;">' + NOW_IST.strftime('%A, %d %B %Y') + ' - ' + NOW_IST.strftime('%H:%M IST') + (' - daily wrap' if INCLUDE_DAILY else '') + '</div>')

    total_h6_v = sum(s['h6_v'] for _,_,s in rows_data)
    total_h6_b = sum(s['h6_b'] for _,_,s in rows_data)
    total_ph6_v = sum(s['ph6_v'] for _,_,s in rows_data)
    total_ph6_b = sum(s['ph6_b'] for _,_,s in rows_data)
    delta_v = pct_change(total_h6_v, total_ph6_v)
    parts.append('<div style="margin-top:28px;padding:20px 24px;background:' + P['warm'] + ';border:1px solid ' + P['crease'] + ';">')
    parts.append('<div style="font-family:' + SANS + ';font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:' + P['ink2'] + ';margin-bottom:6px;">Last 6 hours, all integrated sites</div>')
    parts.append('<div style="font-family:' + MONO + ';font-size:32px;font-weight:600;color:' + P['ink'] + ';">' + fmt_num(total_h6_v) + ' visits<span style="font-size:14px;color:' + P['ink2'] + ';font-weight:400;margin-left:10px;">versus ' + fmt_num(total_ph6_v) + ' prior 6 hours (' + fmt_pct(delta_v) + ')</span></div>')
    parts.append('<div style="font-family:' + MONO + ';font-size:11px;color:' + P['ink3'] + ';margin-top:6px;">' + fmt_num(total_h6_b) + ' beacons fired (versus ' + fmt_num(total_ph6_b) + ' prior 6 hours)</div>')
    parts.append('</div>')

    slugs = [slug for _, slug, _ in rows_data]
    if INCLUDE_DAILY:
        buckets, table = six_hour_grid_yesterday(slugs)
        parts.append(render_breakdown(buckets, table, slug_to_domain, 'Yesterday by 6-hour bucket (IST)'))
    else:
        buckets, table = hourly_grid(slugs)
        parts.append(render_breakdown(buckets, table, slug_to_domain, 'Last 6 hours, hourly (IST)'))

    parts.append(section_title('6-hour totals'))
    parts.append('<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + P['crease'] + ';border-collapse:collapse;">')
    parts.append('<tr style="background:' + P['warm'] + ';">' + th('Site') + th('Last 6 hours', 'right') + th('Prior 6 hours', 'right') + th('Visit change', 'right') + '</tr>')
    for domain, slug, s in rows_data:
        d = pct_change(s['h6_v'], s['ph6_v'])
        d_str = fmt_pct(d)
        if d is None or d == float('inf'):
            d_color = P['ink2']
        elif d >= 0:
            d_color = P['sage']
        else:
            d_color = P['brick']
        parts.append('<tr>' + td(html.escape(domain)) + cell_vb(s['h6_v'], s['h6_b']) + cell_vb(s['ph6_v'], s['ph6_b']) + td(d_str, 'right', True, d_color) + '</tr>')
    parts.append('</table>')

    if all_alerts:
        parts.append(section_title('Alerts'))
        parts.append('<ul style="padding-left:20px;margin:0;">')
        for color, msg in all_alerts:
            parts.append('<li style="font-family:' + SANS + ';font-size:13px;color:' + P[color] + ';margin-bottom:6px;line-height:1.5;">' + html.escape(msg) + '</li>')
        parts.append('</ul>')

    if INCLUDE_DAILY:
        parts.append(section_title('Daily wrap'))
        parts.append('<div style="font-family:' + SANS + ';font-size:12px;color:' + P['ink2'] + ';margin-bottom:10px;">Day boundary in IST. Cells show visits / beacons. Pre-cliff data lacks session ids; visits there equals beacons.</div>')
        parts.append('<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + P['crease'] + ';border-collapse:collapse;">')
        parts.append('<tr style="background:' + P['warm'] + ';">' + th('Site') + th('Today', 'right') + th('Yesterday', 'right') + th('Visit change', 'right') + th('7 days', 'right') + th('Previous 7 days', 'right') + '</tr>')
        for domain, slug, s in rows_data:
            d_dod = pct_change(s['today_v'], s['yest_v'])
            d_wow = pct_change(s['d7_v'], s['pd7_v'])
            parts.append('<tr>' + td(html.escape(domain))
                + cell_vb(s['today_v'], s['today_b'])
                + cell_vb(s['yest_v'], s['yest_b'])
                + td(fmt_pct(d_dod), 'right', True)
                + cell_vb(s['d7_v'], s['d7_b'])
                + cell_vb(s['pd7_v'], s['pd7_b'])
                + '</tr>')
        parts.append('</table>')

    su = signups()
    parts.append(section_title('New signups, last 24 hours'))
    if not su:
        parts.append('<div style="font-family:' + SANS + ';font-size:13px;color:' + P['ink2'] + ';">None.</div>')
    else:
        parts.append('<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + P['crease'] + ';border-collapse:collapse;">')
        parts.append('<tr style="background:' + P['warm'] + ';">' + th('Domain') + th('Email') + th('Verified') + th('Pipeline') + th('Created (IST)') + '</tr>')
        for r in su:
            r = (r + ['','','','','',''])[:6]
            domain, slug, email, verified, pipeline, created = r[0], r[1], r[2], r[3], r[4], r[5]
            v_color = P['sage'] if verified in ('t','true') else P['ink3']
            v_label = 'verified' if verified in ('t','true') else 'pending'
            parts.append('<tr>' + td(html.escape(domain or '-'))
                + td(html.escape((email or '')[:40] or '-'))
                + td(v_label, 'left', False, v_color)
                + td(html.escape(pipeline or '-'))
                + td(html.escape(created[:16] if created else '-'), 'left', True)
                + '</tr>')
        parts.append('</table>')

    parts.append('<div style="margin-top:36px;padding-top:20px;border-top:1px solid ' + P['crease'] + ';font-family:' + MONO + ';font-size:10px;color:' + P['ink3'] + ';letter-spacing:0.04em;">Generated ' + NOW_UTC.strftime('%Y-%m-%d %H:%M:%S UTC') + ' - source: geo_page_views, geo_sites - script: scripts/ops/customer-report.py - Visits count initial-load page views only. Beacons count every event including engagement.</div>')
    parts.append('</td></tr></table></td></tr></table></body></html>')
    return ''.join(parts)

def parse_mailenv(path='/home/aditya/.mailenv'):
    creds = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, _, v = line.partition('=')
        creds[k.strip()] = v.strip().strip(chr(34)).strip(chr(39))
    return creds

def send(html_body):
    creds = parse_mailenv()
    sender = creds['MAIL_FROM']
    password = creds['MAIL_APP_PASSWORD']
    smtp_host = 'smtp.gmail.com'
    msg = MIMEMultipart('related')
    msg['Subject'] = SUBJECT
    msg['From'] = sender
    msg['To'] = TO_ADDR
    alt = MIMEMultipart('alternative')
    msg.attach(alt)
    alt.attach(MIMEText('FlowBlinq integration report. Open in an HTML-capable client.', 'plain'))
    alt.attach(MIMEText(html_body, 'html'))
    if LOGO_PATH.exists():
        img = MIMEImage(LOGO_PATH.read_bytes(), _subtype='gif')
        img.add_header('Content-ID', '<' + LOGO_CID + '>')
        img.add_header('Content-Disposition', 'inline', filename='flowblinq-logo.gif')
        msg.attach(img)
    with smtplib.SMTP_SSL(smtp_host, 465, context=ssl.create_default_context()) as smtp:
        smtp.login(sender, password)
        smtp.send_message(msg)
    print('sent to ' + TO_ADDR)

if __name__ == '__main__':
    body = build()
    if DRY_RUN:
        print(body)
    else:
        send(body)
