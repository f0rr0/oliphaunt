SELECT plan(2);
-- oliphaunt-statement
SELECT ok(true, 'pgTAP ok() executes');
-- oliphaunt-statement
SELECT is(1, 1, 'pgTAP is() compares values');
-- oliphaunt-statement
SELECT * FROM finish();
