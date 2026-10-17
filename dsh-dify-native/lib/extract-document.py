"""Strict byte transport around the fixed official extraction functions."""
import base64, importlib.util, json, sys
from pathlib import Path

try:
    payload=json.load(sys.stdin)
    data=base64.b64decode(payload['bytes'],validate=True)
    ext=payload['extension'].lower()
    kinds={'.pdf':'pdf','.docx':'docx','.xlsx':'excel','.xls':'excel','.csv':'csv','.json':'json','.yaml':'yaml','.yml':'yaml','.vtt':'vtt','.properties':'properties'}
    plain={'.txt','.md','.markdown','.xml','.html','.htm','.log','.ini','.cfg','.conf','.toml','.py','.js','.mjs','.cjs','.ts','.css','.sql','.jsonl','.tsv'}
    kind=kinds.get(ext,'plain_text' if ext in plain else None)
    if kind is None: raise ValueError(f'{ext} requires an explicit document conversion service; not installed by the lightweight extraction dependencies')
    if kind in ('plain_text','csv','json','yaml','vtt','properties') and b'\0' in data and not data.startswith((b'\xff\xfe',b'\xfe\xff')):
        raise ValueError('binary content in text document')
    spec=importlib.util.spec_from_file_location('document_parsers',Path(__file__).with_name('document-parsers.py'))
    parsers=importlib.util.module_from_spec(spec)
    try: spec.loader.exec_module(parsers)
    except ImportError as e:
        raise ValueError(f'Missing extraction dependency {e.name}. Run scripts/install-extraction.sh with DIFY_RUNTIME_PYTHON, or install requirements-extraction.txt in a new directory and set DIFY_EXTRACTION_VENDOR / DIFY_PYTHONPATH') from e
    # Validate sheets before calling official code, which otherwise silently drops
    # failing sheets. Do not convert partial workbook failure into success.
    if kind=='excel':
        book=parsers.pd.ExcelFile(parsers.io.BytesIO(data))
        for sheet in book.sheet_names: book.parse(sheet_name=sheet)
    text=getattr(parsers,'_extract_text_from_'+kind)(data)
    print(json.dumps({'ok':True,'text':text,'engine':'dify-cd47a47-'+kind},ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok':False,'error':f'{type(e).__name__}: {e}'}))
