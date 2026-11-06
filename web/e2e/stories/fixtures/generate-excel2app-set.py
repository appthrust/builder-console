"""Generate the three excel2app-set-*.xlsx fixtures using only Python's stdlib.

Two monthly ledgers share headers and refer to a master in a separate file.
Fixed member ordering and ZIP metadata make the outputs reproducible.
Run: python3 path/to/generate-excel2app-set.py
"""

from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def workbook(filename, sheet, rows, ledger=False):
    sheet_rows = []
    for row_index, row in enumerate(rows, start=1):
        cells = []
        for column, value in enumerate(row):
            coordinate = f'{chr(65 + column)}{row_index}'
            if ledger and row_index > 1 and column == 6:
                cells.append(f'<c r="{coordinate}"><f>E{row_index}*F{row_index}</f><v>{value}</v></c>')
            elif isinstance(value, (int, float)):
                cells.append(f'<c r="{coordinate}"><v>{value}</v></c>')
            else:
                cells.append(f'<c r="{coordinate}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
        sheet_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    validation = '<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="H2:H3"><formula1>"未着手,完了"</formula1></dataValidation></dataValidations>' if ledger else ''
    parts = {
        '[Content_Types].xml': '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>''',
        '_rels/.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<workbook xmlns="{SHEET_NS}" xmlns:r="{REL_NS}"><sheets><sheet name="{sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{SHEET_NS}"><dimension ref="A1:{chr(64 + len(rows[0]))}{len(rows)}"/><sheetData>{"".join(sheet_rows)}</sheetData>{validation}</worksheet>',
    }
    output = Path(__file__).with_name(filename)
    with ZipFile(output, 'w') as archive:
        for name, contents in parts.items():
            member = ZipInfo(name, date_time=(2026, 11, 1, 0, 0, 0))
            member.compress_type = ZIP_DEFLATED
            member.external_attr = 0o100644 << 16
            archive.writestr(member, XML + contents + '\n')
    print(f'{output.name}: {output.stat().st_size} bytes')


headers = ['受注番号', '受注日', '得意先コード', '品名', '数量', '単価', '金額', '状態']
workbook('excel2app-set-april.xlsx', '受注一覧', [headers,
    ['A-001', '2026-04-02', 'C-001', '4月の歯車', 3, 400, 1200, '未着手'],
    ['A-002', '2026-04-12', 'C-002', '4月の軸', 2, 500, 1000, '完了'],
], ledger=True)
workbook('excel2app-set-may.xlsx', '受注一覧', [headers,
    ['M-001', '2026-05-03', 'C-001', '5月の歯車', 4, 400, 1600, '未着手'],
    ['M-002', '2026-05-14', 'C-002', '5月の軸', 3, 500, 1500, '完了'],
], ledger=True)
workbook('excel2app-set-customers.xlsx', '得意先マスタ', [
    ['得意先コード', '得意先名', '担当'],
    ['C-001', '青空工業', '田中'],
    ['C-002', '若葉製作所', '佐藤'],
])
