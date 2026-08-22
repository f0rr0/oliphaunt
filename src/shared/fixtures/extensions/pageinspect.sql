CREATE TEMP TABLE oliphaunt_pageinspect (id int);
-- oliphaunt-statement
INSERT INTO oliphaunt_pageinspect SELECT generate_series(1, 5);
-- oliphaunt-statement
SELECT * FROM page_header(get_raw_page('oliphaunt_pageinspect', 0));
