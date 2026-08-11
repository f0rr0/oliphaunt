\set ON_ERROR_STOP on

COPY (
  SELECT relation,
         row_count,
         numeric_sum,
         hash_sum,
         hash_xor
  FROM (
    SELECT
      'accounts'::text AS relation,
      count(*)::numeric AS row_count,
      sum(balance)::numeric AS numeric_sum,
      sum(hashtextextended(
        client_id::text || ':' || slot::text || ':' ||
        balance::text || ':' || payload, 0
      )::numeric) AS hash_sum,
      bit_xor(hashtextextended(
        client_id::text || ':' || slot::text || ':' ||
        balance::text || ':' || payload, 0
      )) AS hash_xor
    FROM oliphaunt_checkpoint_accounts
    UNION ALL
    SELECT
      'append', count(*)::numeric, sum(sequence)::numeric,
      sum(hashtextextended(
        client_id::text || ':' || sequence::text || ':' ||
        ordinal::text || ':' || payload, 0
      )::numeric),
      bit_xor(hashtextextended(
        client_id::text || ':' || sequence::text || ':' ||
        ordinal::text || ':' || payload, 0
      ))
    FROM oliphaunt_checkpoint_append
    UNION ALL
    SELECT
      'volume', count(*)::numeric, sum(value)::numeric,
      sum(hashtextextended(
        id::text || ':' || value::text || ':' || payload, 0
      )::numeric),
      bit_xor(hashtextextended(
        id::text || ':' || value::text || ':' || payload, 0
      ))
    FROM oliphaunt_checkpoint_volume
  ) AS state
  ORDER BY relation
) TO STDOUT WITH (FORMAT csv, HEADER true, DELIMITER E'\t');
