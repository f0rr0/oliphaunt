CREATE TEMP TABLE oliphaunt_tcn (id int PRIMARY KEY, value text);
-- oliphaunt-statement
CREATE TRIGGER oliphaunt_tcn_trigger AFTER INSERT OR UPDATE OR DELETE ON oliphaunt_tcn FOR EACH ROW EXECUTE FUNCTION triggered_change_notification();
-- oliphaunt-statement
INSERT INTO oliphaunt_tcn VALUES (1, 'one');
