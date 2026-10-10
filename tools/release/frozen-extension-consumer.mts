export async function checkExtensions(
  database: {
    execute(sql: string): Promise<unknown>;
    queryRaw(sql: string): Promise<{ getText(row: number, column: string): string | null }>;
  },
  sqlNames: readonly string[],
) {
  for (const sqlName of sqlNames)
    await database.execute(`CREATE EXTENSION "${sqlName.replaceAll('"', '""')}" CASCADE`);
  if (
    sqlNames.includes('vector') &&
    (await database.queryRaw("SELECT vector_dims('[1,2,3]'::vector) AS dimensions")).getText(
      0,
      'dimensions',
    ) !== '3'
  )
    throw new Error('installed vector extension returned the wrong dimensions');
}
