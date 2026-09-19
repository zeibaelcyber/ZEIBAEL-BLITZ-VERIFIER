-- READ ONLY. Each output row is exact PostgreSQL jsonb text used by source-manifest hashing.
select jsonb_build_object(
  'table','zeibael_acker_runs',
  'id',id,'status',status,'created_at',created_at,'completed_at',completed_at,
  'final_result',final_result,'evidence_bundle',evidence_bundle,'qc_summary',qc_summary
)::text
from public.zeibael_acker_runs
where upper(coalesce(status,'')) in ('SUCCEEDED','FAILED','CANCELLED')
order by id;

select jsonb_build_object(
  'table','zeibael_tasks',
  'id',id,'status',status,'created_at',created_at,'completed_at',completed_at,
  'capability_key',capability_key,'selected_provider',selected_provider,
  'payload',payload,'result',result
)::text
from public.zeibael_tasks
where upper(coalesce(status,'')) in ('SUCCEEDED','FAILED','CANCELLED')
order by id;

select jsonb_build_object(
  'table','zeibael_acker_run_workers',
  'id',id,'run_id',run_id,'task_id',task_id,'status',status,
  'agent_key',agent_key,'provider_key',provider_key,'model_key',model_key,'result',result
)::text
from public.zeibael_acker_run_workers
where upper(coalesce(status,'')) in ('SUCCEEDED','FAILED','CANCELLED')
order by id;
