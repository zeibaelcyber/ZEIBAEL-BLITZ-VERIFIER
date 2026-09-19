-- READ ONLY. Source snapshot manifest for ZEIBAEL completed-run archive.
with
run_rows as (
  select id::text as id,
    jsonb_build_object(
      'table','zeibael_acker_runs','id',id,'status',status,
      'created_at',created_at,'completed_at',completed_at,
      'final_result',final_result,'evidence_bundle',evidence_bundle,'qc_summary',qc_summary
    )::text as archive_text
  from public.zeibael_acker_runs
  where upper(coalesce(status,'')) in ('SUCCEEDED','FAILED','CANCELLED')
),
task_rows as (
  select id::text as id,
    jsonb_build_object(
      'table','zeibael_tasks','id',id,'status',status,
      'created_at',created_at,'completed_at',completed_at,
      'capability_key',capability_key,'selected_provider',selected_provider,
      'payload',payload,'result',result
    )::text as archive_text
  from public.zeibael_tasks
  where upper(coalesce(status,'')) in ('SUCCEEDED','FAILED','CANCELLED')
),
worker_rows as (
  select id::text as id,
    jsonb_build_object(
      'table','zeibael_acker_run_workers','id',id,'run_id',run_id,'task_id',task_id,
      'status',status,'agent_key',agent_key,'provider_key',provider_key,
      'model_key',model_key,'result',result
    )::text as archive_text
  from public.zeibael_acker_run_workers
  where upper(coalesce(status,'')) in ('SUCCEEDED','FAILED','CANCELLED')
),
stats as (
  select 'zeibael_acker_runs'::text as table_name,count(*)::bigint as rows,
         coalesce(sum(octet_length(archive_text)),0)::bigint as archive_text_bytes,
         md5(coalesce(string_agg(md5(archive_text),'' order by id),'')) as snapshot_hash_md5
  from run_rows
  union all
  select 'zeibael_tasks',count(*),coalesce(sum(octet_length(archive_text)),0),
         md5(coalesce(string_agg(md5(archive_text),'' order by id),''))
  from task_rows
  union all
  select 'zeibael_acker_run_workers',count(*),coalesce(sum(octet_length(archive_text)),0),
         md5(coalesce(string_agg(md5(archive_text),'' order by id),''))
  from worker_rows
),
active as (
  select
    (select count(*) from public.zeibael_acker_runs where upper(coalesce(status,'')) not in ('SUCCEEDED','FAILED','CANCELLED'))::bigint as runs,
    (select count(*) from public.zeibael_tasks where upper(coalesce(status,'')) not in ('SUCCEEDED','FAILED','CANCELLED'))::bigint as tasks,
    (select count(*) from public.zeibael_acker_run_workers where upper(coalesce(status,'')) not in ('SUCCEEDED','FAILED','CANCELLED'))::bigint as workers
)
select jsonb_build_object(
  'schema','zeibael.shadow_archive_source_manifest.v1',
  'canonical_state','Supabase/PostgreSQL',
  'read_only',true,
  'active',jsonb_build_object('runs',active.runs,'tasks',active.tasks,'workers',active.workers),
  'tables',(select jsonb_object_agg(table_name,jsonb_build_object(
      'rows',rows,'archive_text_bytes',archive_text_bytes,'snapshot_hash_md5',snapshot_hash_md5
  )) from stats)
)::text
from active;
