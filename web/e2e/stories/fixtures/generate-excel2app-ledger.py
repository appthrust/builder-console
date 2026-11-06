"""Regenerate excel2app-ledger.xlsx with Python 3's standard library.

Run from any directory: python3 path/to/generate-excel2app-ledger.py
Sheet 台帳: merged title in row 1, blank row 2, two-row header in rows 3-4,
records in rows 5 and 9 with blank rows 6-7 and a section title in row 8,
formula C5*D5 with cached value 1200, and a list validation on column B that
reads the hidden sheet 選択肢. The app-create-excel2app mock story uploads it
through Chromium; xlsx.test.ts reads it with happy-dom. Fixed ZIP metadata
makes regeneration deterministic; do not hand-edit the binary.
"""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

parts = {
    '[Content_Types].xml': '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>''',
    '_rels/.rels': f'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="{REL_NS}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>''',
    'xl/workbook.xml': f'''<workbook xmlns="{SHEET_NS}" xmlns:r="{REL_NS}">
  <sheets>
    <sheet name="台帳" sheetId="1" r:id="rId1"/>
    <sheet name="選択肢" sheetId="2" state="hidden" r:id="rId2"/>
  </sheets>
</workbook>''',
    'xl/_rels/workbook.xml.rels': f'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="{REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="{REL_NS}/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>''',
    'xl/worksheets/sheet1.xml': f'''<worksheet xmlns="{SHEET_NS}">
  <dimension ref="A1:E9"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>部品管理台帳</t></is></c></row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>管理</t></is></c>
      <c r="C3" t="inlineStr"><is><t>見積</t></is></c>
    </row>
    <row r="4">
      <c r="A4" t="inlineStr"><is><t>管理No</t></is></c>
      <c r="B4" t="inlineStr"><is><t>状態</t></is></c>
      <c r="C4" t="inlineStr"><is><t>数量</t></is></c>
      <c r="D4" t="inlineStr"><is><t>単価</t></is></c>
      <c r="E4" t="inlineStr"><is><t>金額</t></is></c>
    </row>
    <row r="5">
      <c r="A5" t="inlineStr"><is><t>P-001</t></is></c>
      <c r="B5" t="inlineStr"><is><t>未着手</t></is></c>
      <c r="C5"><v>3</v></c><c r="D5"><v>400</v></c>
      <c r="E5"><f>C5*D5</f><v>1200</v></c>
    </row>
    <row r="8"><c r="A8" t="inlineStr"><is><t>次の区分</t></is></c></row>
    <row r="9">
      <c r="A9" t="inlineStr"><is><t>P-002</t></is></c>
      <c r="B9" t="inlineStr"><is><t>完了</t></is></c>
      <c r="D9"><v>250</v></c>
    </row>
  </sheetData>
  <mergeCells count="3"><mergeCell ref="A1:E1"/><mergeCell ref="A3:B3"/><mergeCell ref="C3:E3"/></mergeCells>
  <dataValidations count="1">
    <dataValidation type="list" allowBlank="1" sqref="B5:B9"><formula1>'選択肢'!$A$1:$A$2</formula1></dataValidation>
  </dataValidations>
</worksheet>''',
    'xl/worksheets/sheet2.xml': f'''<worksheet xmlns="{SHEET_NS}">
  <dimension ref="A1:A2"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>未着手</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>完了</t></is></c></row>
  </sheetData>
</worksheet>''',
}

output = Path(__file__).with_name('excel2app-ledger.xlsx')
with ZipFile(output, 'w') as archive:
    for name, contents in parts.items():
        member = ZipInfo(name, date_time=(2026, 10, 29, 0, 0, 0))
        member.compress_type = ZIP_DEFLATED
        member.external_attr = 0o100644 << 16
        archive.writestr(member, XML + contents + '\n')
print(f'{output.name}: {output.stat().st_size} bytes')
