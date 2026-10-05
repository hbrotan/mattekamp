-- Visningsnavn på samlingen settet hører til (f.eks. «Kenguru», «GetSmart»)
alter table task_sets add source_name nvarchar(50) not null default '';
