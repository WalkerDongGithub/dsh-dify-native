"""AST-load only pure extractors from the fixed official source, no Dify imports."""
import ast, csv, io, json, logging, sys
from pathlib import Path
import chardet, docx, pandas as pd, pypdfium2, webvtt, yaml
from docx.document import Document
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph
TextExtractionError = ValueError
logger = logging.getLogger(__name__)
NAMES = ['_extract_text_from_plain_text','_extract_text_from_json','_extract_text_from_yaml','_extract_text_from_pdf','parser_docx_part','_extract_text_from_docx','_extract_text_from_csv','_extract_text_from_excel','_extract_text_from_vtt','_extract_text_from_properties']
source = Path(__file__).resolve().parents[1] / 'fixtures/dify-cd47a47-document-extractor.py'
module = ast.parse(source.read_text())
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n, ast.FunctionDef) and n.name in NAMES],type_ignores=[]),str(source),'exec'))
if __name__ == '__main__':
    root=Path(sys.argv[1])
    from openpyxl import Workbook
    d=docx.Document(); d.add_paragraph('Actual Office'); d.add_paragraph('Before 段落');t=d.add_table(rows=2,cols=2)
    t.cell(0,0).text='Header';t.cell(0,1).text='Long Heading';t.cell(1,0).text='line1\nline2';t.cell(1,1).text='42';d.add_paragraph('After');d.save(root/'real.docx')
    w=Workbook();s=w.active;s.append([' Name\nHeader ','Value']);s.append(['Ada',3]);s.append([None,None]);s.append([' spaced ',2.5]);s=w.create_sheet('other');s.append(['Col','N']);s.append(['Hello\nworld',True]);s.append(['formula','=1+2']);w.save(root/'real.xlsx')
    (root/'real.pdf').write_bytes((source.parent/'extraction.pdf').read_bytes())
    cases={'real.pdf':'pdf','real.docx':'docx','real.xlsx':'excel','data.csv':'csv','data.json':'json','data.yaml':'yaml','data.vtt':'vtt','data.properties':'properties'}
    (root/'data.csv').write_text('name,long heading\nAda,"hello\nworld"\n')
    (root/'data.json').write_text('{"z":1,"name":"中文"}')
    (root/'data.yaml').write_text('a: 1\nlabel: 中文\n---\nb: [2, 3]\n')
    (root/'data.vtt').write_text('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Ada>Hello\n\n00:00:01.000 --> 00:00:02.000\n<v Ada>world\n')
    (root/'data.properties').write_text('# comment\na = b\nx:y\n! keep\nlonely\n')
    expected={name:globals()['_extract_text_from_'+fmt]((root/name).read_bytes()) for name,fmt in cases.items()}
    (root/'expected.json').write_text(json.dumps(expected,ensure_ascii=False))
