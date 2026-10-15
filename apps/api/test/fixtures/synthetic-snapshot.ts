import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

/**
 * SYNTHETIC test snapshot with the same layout and column names as a pipeline export
 * (tables/*.parquet + schema.json/tables.json/run.json). Values are invented for tests only.
 *
 * Layout around the default center (30.2672, -97.7431):
 *  P1 at center        roof 25y (year built), open permit A 2000 days (contractor ctr_acme)
 *  P2 ~1 mi north      roof 10y, no permits
 *  P3 ~2 mi south      roof 18y (finaled roof permit C), expired-unfinaled permit E (no coords -> parcel coords)
 *  P4 ~8 mi north      roof 30y, open permit B 400 days "reroof tear off" (ctr_lonestar)
 *  P5 no coordinates   excluded from the map
 *  P6 at Testville     open permit D 2500 days (ctr_acme)
 */
export const FIXTURE = {
  center: { lat: 30.2672, lng: -97.7431 },
  testville: { lat: 30.4394, lng: -97.62 },
  runId: "fixture-run-0001",
};

const PROPERTIES = `
SELECT * FROM (VALUES
  ('P1','G1','100 MAIN ST','100','MAIN ST','AUSTIN','78701',30.2672,-97.7431,'OWNER ONE',NULL,'PO BOX 1','DALLAS','TX','75201','regional_texas',true,'A1','A1',100000.0,200000.0,300000.0,5000.0,'sqft',2025,2001,2001,25,'tcad_year_built','medium',NULL,NULL,0,1,1,2000,'A-OPEN',0,'A-OPEN',DATE '2021-01-01',1),
  ('P2','G2','200 NORTH ST','200','NORTH ST','AUSTIN','78701',30.2817,-97.7431,'OWNER TWO',NULL,'200 NORTH ST','AUSTIN','TX','78701','local',false,'A1','A1',90000.0,150000.0,240000.0,4000.0,'sqft',2025,2016,2016,10,'tcad_year_built','medium',NULL,NULL,0,0,0,NULL,NULL,0,NULL,NULL,0),
  ('P3','G3','300 SOUTH ST','300','SOUTH ST','AUSTIN','78704',30.2382,-97.7431,'OWNER THREE','C/O TRUST','300 SOUTH ST','AUSTIN','TX','78704','local',false,'A1','A1',80000.0,120000.0,200000.0,4200.0,'sqft',2025,1990,2008,18,'final_roof_replacement_permit','high',DATE '2008-05-01','C-FINAL',1,2,0,NULL,NULL,1,'E-EXPIRED',DATE '2019-03-01',2),
  ('P4','G4','400 FAR RD','400','FAR RD','AUSTIN','78758',30.3830,-97.7431,'OWNER FOUR',NULL,'1 MAIN','DENVER','CO','80202','out_of_state',true,'A1','A1',70000.0,100000.0,170000.0,3900.0,'sqft',2025,1996,1996,30,'tcad_year_built','medium',NULL,NULL,0,1,1,400,'B-OPEN',0,'B-OPEN',DATE '2024-08-01',1),
  ('P5','G5','500 NOWHERE',NULL,NULL,'AUSTIN','78701',NULL,NULL,'OWNER FIVE',NULL,NULL,NULL,NULL,NULL,'unknown',false,'A1','A1',NULL,NULL,NULL,NULL,NULL,2025,1980,1980,46,'tcad_year_built','medium',NULL,NULL,0,0,0,NULL,NULL,0,NULL,NULL,0),
  ('P6','G6','600 TEST LN','600','TEST LN','TESTVILLE','78660',30.4394,-97.6200,'OWNER SIX',NULL,'600 TEST LN','TESTVILLE','TX','78660','local',false,'A1','A1',60000.0,90000.0,150000.0,3000.0,'sqft',2025,NULL,NULL,NULL,'no_evidence','none',NULL,NULL,0,1,1,2500,'D-OPEN',0,'D-OPEN',DATE '2019-02-01',1)
) t(prop_id, geo_id, situs_address, situs_number, situs_street, situs_city, situs_zip, latitude, longitude,
    owner_name, owner_care_of, mail_address, mail_city, mail_state, mail_zip, owner_location_class, absentee_owner_signal,
    land_use_state_code, land_use_local_code, land_value, improvement_value, market_value, gis_area, gis_area_unit, tax_year,
    year_built, roof_year, roof_age_years, roof_age_basis, roof_age_confidence, roof_evidence_date, roof_evidence_permit_number,
    roof_evidence_count, roofing_permit_count, open_roofing_permit_count, oldest_open_roofing_permit_days,
    oldest_open_roofing_permit_number, expired_unfinaled_roofing_permit_count, last_roofing_permit_number,
    last_roofing_permit_date, permit_count)`;

const PERMITS = `
SELECT * FROM (VALUES
  ('A-OPEN','P1','tcad_geo_id',true,'BP','R- 434 Addition & Alterations','Remodel','Residential reroof shingles','roof_replacement','Active',true,DATE '2020-01-01',DATE '2020-06-01',DATE '2020-06-01',DATE '2021-06-01',NULL,2000,false,'100 MAIN ST','AUSTIN','78701','AUSTIN FULL PURPOSE',30.2672,-97.7431,'ACME ROOFING LLC',NULL,'5125550100','General Contractor','ctr_acme','Acme Roofing LLC','32000000001',NULL,NULL,NULL,12000.0,'https://example.test/permit/A','austin_permits','https://example.test/source/A','aaaa',TIMESTAMP '2026-10-01 00:00:00','r1','r1'),
  ('B-OPEN','P4','tcad_geo_id',true,'BP','R- 434 Addition & Alterations','Repair','Reroof tear off and replace decking','roof_replacement','Active',true,DATE '2024-07-01',DATE '2024-08-01',DATE '2024-08-01',DATE '2025-08-01',NULL,400,false,'400 FAR RD','AUSTIN','78758','AUSTIN FULL PURPOSE',30.3830,-97.7431,'LONE STAR ROOF CO',NULL,'5125550200','Roofing','ctr_lonestar','Lone Star Roof Co',NULL,NULL,NULL,NULL,8000.0,'https://example.test/permit/B','austin_permits','https://example.test/source/B','bbbb',TIMESTAMP '2026-10-01 00:00:00','r1','r1'),
  ('C-FINAL','P3','tcad_geo_id',true,'BP','R- 434 Addition & Alterations','Repair','Roof replacement','roof_replacement','Final',false,DATE '2008-01-01',DATE '2008-02-01',DATE '2008-05-01',NULL,DATE '2008-05-01',NULL,false,'300 SOUTH ST','AUSTIN','78704','AUSTIN FULL PURPOSE',30.2382,-97.7431,'LONE STAR ROOF CO',NULL,NULL,'Roofing','ctr_lonestar','Lone Star Roof Co',NULL,NULL,NULL,NULL,7000.0,NULL,'austin_permits','https://example.test/source/C','cccc',TIMESTAMP '2026-10-01 00:00:00','r1','r1'),
  ('D-OPEN','P6','point_in_parcel',true,'BP','R- 434 Addition & Alterations','Remodel','Roof replacement after hail','roof_replacement','Active',true,DATE '2018-12-01',DATE '2019-02-01',DATE '2019-02-01',DATE '2020-02-01',NULL,2500,false,'600 TEST LN','TESTVILLE','78660','TESTVILLE',30.4394,-97.6200,'ACME ROOFING LLC',NULL,'5125550100','General Contractor','ctr_acme','Acme Roofing LLC','32000000001',NULL,NULL,NULL,15000.0,'https://example.test/permit/D','austin_permits','https://example.test/source/D','dddd',TIMESTAMP '2026-10-01 00:00:00','r1','r1'),
  ('E-EXPIRED','P3','tcad_geo_id',true,'BP','R- 434 Addition & Alterations','Repair','Reroof','roof_replacement','Expired',false,DATE '2019-01-01',DATE '2019-03-01',DATE '2020-03-01',DATE '2020-03-01',NULL,NULL,true,'300 SOUTH ST','AUSTIN','78704','AUSTIN FULL PURPOSE',NULL,NULL,NULL,'JOHN DOE','5125550300',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'austin_permits','https://example.test/source/E','eeee',TIMESTAMP '2026-10-01 00:00:00','r1','r1')
) t(permit_number, prop_id, parcel_match_method, in_county, permit_type, permit_class, work_class, description, roofing_match,
    status, is_open, applied_date, issued_date, status_date, expires_date, completed_date, open_days, expired_without_final,
    address, city, zip, jurisdiction, latitude, longitude, contractor_company_name, contractor_full_name, contractor_phone,
    contractor_trade, contractor_id, contractor_name, contractor_taxpayer_number, contractor_bbb_id, contractor_bbb_rating,
    contractor_bbb_accredited, total_job_valuation, permit_link, source_id, source_url, raw_sha256, collected_at,
    first_seen_run, last_changed_run)`;

const CONTRACTORS = `
SELECT * FROM (VALUES
  ('ctr_acme','Acme Roofing LLC',['Acme Roofing LLC','ACME ROOFING'],['5125550100'],'1 Acme Way','AUSTIN','78701',['General Contractor'],10,2,2,DATE '2010-01-01',DATE '2020-06-01','32000000001','exact_name_key',NULL,NULL),
  ('ctr_lonestar','Lone Star Roof Co',['Lone Star Roof Co'],['5125550200'],NULL,'AUSTIN','78758',['Roofing'],5,2,1,DATE '2008-02-01',DATE '2024-08-01',NULL,NULL,NULL,NULL)
) t(contractor_id, display_name, name_variants, phones, address, city, zip, trades, permit_count, roofing_permit_count,
    open_roofing_permit_count, first_permit_issued, last_permit_issued, taxpayer_number, business_match_method, place_id, bbb_id)`;

const BBB = `SELECT NULL::VARCHAR AS bbb_id, NULL::VARCHAR AS name, NULL::VARCHAR AS name_key, NULL::VARCHAR AS rating,
  NULL::BOOLEAN AS accredited, NULL::VARCHAR AS profile_url WHERE false`;

const GEO = `
SELECT * FROM (VALUES
  ('4805000','Austin city','Austin','city',30.2672,-97.7431),
  ('4899999','Testville city','Testville','city',30.4394,-97.6200)
) t(geoid, name, basename, place_kind, latitude, longitude)`;

export async function createSyntheticSnapshot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "roofing-crm-fixture-"));
  const dir = path.join(root, "exports", FIXTURE.runId);
  await mkdir(path.join(dir, "tables"), { recursive: true });
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const tables: [string, string][] = [
    ["property_leads", PROPERTIES],
    ["roofing_permits", PERMITS],
    ["contractors", CONTRACTORS],
    ["bbb_profiles", BBB],
    ["geo_places", GEO],
  ];
  const schema: Record<string, { description: string; columns: { name: string; type: string }[] }> = {};
  const exported: { name: string; file: string; rows: number; description: string }[] = [];
  for (const [name, sql] of tables) {
    const file = path.join(dir, "tables", `${name}.parquet`);
    const asOf =
      name === "property_leads"
        ? `SELECT *, DATE '2026-10-01' AS as_of_date, 'https://example.test/parcel/' || prop_id AS parcel_source_url, TIMESTAMP '2026-10-01 00:00:00' AS parcel_collected_at FROM (${sql})`
        : sql;
    await conn.run(`COPY (${asOf}) TO '${file}' (FORMAT parquet)`);
    const cols = (
      await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${file}')`)
    ).getRowObjectsJS();
    const rows = Number(
      (await conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${file}')`)).getRowObjectsJS()[0]
        ?.n ?? 0,
    );
    schema[name] = {
      description: `synthetic ${name}`,
      columns: cols.map((c) => ({ name: String(c.column_name), type: String(c.column_type) })),
    };
    exported.push({ name, file: `tables/${name}.parquet`, rows, description: `synthetic ${name}` });
  }
  conn.closeSync();
  await writeFile(path.join(dir, "schema.json"), JSON.stringify(schema, null, 2));
  await writeFile(path.join(dir, "tables.json"), JSON.stringify(exported, null, 2));
  await writeFile(
    path.join(dir, "run.json"),
    JSON.stringify({
      asOf: "2026-10-01",
      run: { run_id: FIXTURE.runId },
      sources: [{ source_id: "bbb", status: "skipped", limitation: "BBB harvest pending (synthetic)" }],
    }),
  );
  await writeFile(path.join(dir, "coverage.json"), "{}");
  return dir;
}
