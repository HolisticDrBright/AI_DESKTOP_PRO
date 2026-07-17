-- 0025: pin search_path on the two 0024 guard trigger functions flagged by
-- the security advisor (function_search_path_mutable). Every other function
-- in the project already pins it; these two were missed.
alter function private.lens_evaluation_guard() set search_path = '';
alter function private.lens_safety_block_guard() set search_path = '';
