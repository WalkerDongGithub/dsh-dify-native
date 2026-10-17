"""Strict byte transport around the fixed official extraction functions."""
import base64, importlib.util, json, sys
from pathlib import Path

try:
    payload=json.load(sys.stdin)
    data=base64.b64decode(payload['bytes'],validate=True)
    ext=payload.get('extension') or ''
    mime=payload.get('mime_type') or ''
    spec=importlib.util.spec_from_file_location('document_parsers',Path(__file__).with_name('document-parsers.py'))
    parsers=importlib.util.module_from_spec(spec)
    try: spec.loader.exec_module(parsers)
    except ImportError as e:
        raise ValueError(f'Missing extraction dependency {e.name}. Run scripts/install-extraction.sh with DIFY_RUNTIME_PYTHON, or install requirements-extraction.txt in a new directory and set DIFY_EXTRACTION_VENDOR / DIFY_PYTHONPATH') from e
    # Extension is authoritative, exactly as official _extract_text_from_file.
    # MIME is only consulted when extension is absent; no guessed MIME map.
    excel=ext in ('.xls','.xlsx') or (not ext and mime in ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel'))
    if excel:
        book=parsers.pd.ExcelFile(parsers.io.BytesIO(data))
        for sheet in book.sheet_names: book.parse(sheet_name=sheet)
    # Guard the textual functions themselves so the official dispatch tables
    # stay authoritative; binary signatures never enter permissive decoding.
    def strict_text(fn):
        def checked(content):
            nul_binary=b'\0' in content and not content.startswith((b'\xff\xfe',b'\xfe\xff'))
            if nul_binary or content.startswith((b'%PDF-',b'PK\x03\x04',b'\x89PNG',b'\x7fELF',b'\xd0\xcf\x11\xe0')):
                raise ValueError('binary content in text document')
            return fn(content)
        return checked
    for name in ('plain_text','json','yaml','csv','properties','vtt'):
        key='_extract_text_from_'+name
        setattr(parsers,key,strict_text(getattr(parsers,key)))
    if ext:
        text=parsers._extract_text_by_file_extension(file_content=data,file_extension=ext)
    elif mime:
        text=parsers._extract_text_by_mime_type(file_content=data,mime_type=mime)
    else:
        raise ValueError('Unable to determine file type: MIME type or file extension is missing')
    print(json.dumps({'ok':True,'text':text,'engine':'dify-cd47a47-route'},ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok':False,'error':f'{type(e).__name__}: {e}'}))
