"""Byte-based lightweight extraction; alternative engines, no implicit installs/OCR."""
import base64, csv, io, json, sys, zipfile
import xml.etree.ElementTree as ET

def table(rows):
    if not rows: return ''
    clean = lambda row: [' '.join(str(c).splitlines()) for c in row]
    rows = [clean(r) for r in rows]
    return '\n'.join(['| ' + ' | '.join(rows[0]) + ' |', '| ' + ' | '.join('-' * len(c) for c in rows[0]) + ' |'] + ['| ' + ' | '.join(r) + ' |' for r in rows[1:]])

def extract(data, ext):
    if ext == '.pdf':
        try: import fitz
        except ImportError: raise ValueError('PDF requires PyMuPDF: install with <configured-python> -m pip install pymupdf; set DIFY_RUNTIME_PYTHON / DIFY_PYTHONPATH')
        with fitz.open(stream=data, filetype='pdf') as doc: return ''.join(p.get_text() for p in doc), 'pymupdf'
    if ext in ('.docx', '.xlsx', '.pptx', '.epub'):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if ext == '.docx':
                ns = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                body = ET.fromstring(z.read('word/document.xml')).find('w:body', ns)
                text = lambda el: ''.join(el.itertext())
                blocks = []
                for b in body:
                    if b.tag.endswith('}p'): blocks.append(''.join(t.text or '' for t in b.findall('.//w:t',ns)))
                    elif b.tag.endswith('}tbl'):
                        blocks.append(table([['\n'.join(''.join(t.text or '' for t in p.findall('.//w:t',ns)) for p in c.findall('w:p',ns)) for c in r.findall('w:tc',ns)] for r in b.findall('w:tr',ns)]))
                return '\n'.join(blocks), 'stdlib-ooxml'
            if ext == '.xlsx':
                ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
                strings=[]
                if 'xl/sharedStrings.xml' in z.namelist(): strings=[''.join(e.itertext()) for e in ET.fromstring(z.read('xl/sharedStrings.xml'))]
                rels={r.attrib['Id']:r.attrib['Target'] for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
                result=[]
                for sheet in ET.fromstring(z.read('xl/workbook.xml')).find('s:sheets',ns):
                    target=rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
                    path=target.lstrip('/') if target.startswith('/') else 'xl/'+target
                    rows=[]
                    for row in ET.fromstring(z.read(path)).findall('.//s:sheetData/s:row',ns):
                        values=[]
                        for c in row:
                            col=0
                            for ch in c.attrib.get('r','A'):
                                if ch.isalpha(): col=col*26+ord(ch.upper())-64
                            while len(values)<col: values.append('')
                            v=c.find('s:v',ns); value=v.text if v is not None else ''
                            if c.attrib.get('t')=='s': value=strings[int(value)]
                            elif c.attrib.get('t')=='inlineStr': value=''.join(c.find('s:is',ns).itertext())
                            elif c.attrib.get('t')=='b': value='True' if value=='1' else 'False'
                            # Never silently return a stale/absent formula cache.
                            if c.find('s:f',ns) is not None: raise ValueError('XLSX formulas require a configured spreadsheet conversion service; cached values are not evaluated')
                            values[col-1]=value
                        if any(values): rows.append(values)
                    result.append(table(rows))
                return '\n\n'.join(result)+'\n\n', 'stdlib-ooxml'
            if ext == '.pptx':
                import re
                paths=sorted((n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)),key=lambda n:int(re.search(r'(\d+)\.xml',n).group(1)))
                return '\n'.join('\n'.join(e.text or '' for e in ET.fromstring(z.read(p)).iter() if e.tag.endswith('}t')) for p in paths), 'stdlib-ooxml'
            raise ValueError('EPUB requires a configured conversion service; no implicit Pandoc download')
    if ext in ('.doc','.ppt','.xls','.msg'):
        raise ValueError(f'{ext} requires a configured document conversion service; convert to docx/pptx/xlsx/text explicitly')
    if ext not in ('.txt','.md','.markdown','.csv','.tsv','.json','.jsonl','.yaml','.yml','.xml','.html','.htm','.log','.ini','.cfg','.conf','.toml','.py','.js','.mjs','.cjs','.ts','.css','.sql','.vtt','.properties','.eml'):
        raise ValueError(f'unsupported document extension {ext!r}; configure a conversion service')
    if b'\x00' in data and not data.startswith((b'\xff\xfe',b'\xfe\xff')): raise ValueError('binary content in text document')
    try: text=data.decode('utf-8-sig')
    except UnicodeDecodeError:
        try: import chardet
        except ImportError: raise ValueError('Non-UTF8 text requires chardet: <configured-python> -m pip install chardet')
        encoding=chardet.detect(data).get('encoding')
        if not encoding: raise ValueError('cannot detect/decode document encoding')
        text=data.decode(encoding,errors='strict')
    if ext=='.json': text=json.dumps(json.loads(text),ensure_ascii=False,indent=2)
    elif ext in ('.csv','.tsv'): text=table(list(csv.reader(io.StringIO(text),delimiter='\t' if ext=='.tsv' else ',')))+'\n'
    elif ext=='.eml':
        from email import policy
        from email.parser import BytesParser
        msg=BytesParser(policy=policy.default).parsebytes(data)
        text='\n'.join(p.get_content() for p in msg.walk() if p.get_content_type()=='text/plain' and p.get_content_disposition()!='attachment')
    return text, 'stdlib-text'

try:
    payload=json.load(sys.stdin)
    text,engine=extract(base64.b64decode(payload['bytes'],validate=True),payload['extension'].lower())
    print(json.dumps({'ok':True,'text':text,'engine':engine},ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok':False,'error':f'{type(e).__name__}: {e}'}))
