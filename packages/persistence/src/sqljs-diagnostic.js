import initSqlJs from 'sql.js';

async function test() {
  const sqlModule = await initSqlJs();
  const Database = sqlModule.Database;
  const db = new Database();

  console.log('Testing db.exec()...');

  // Create table
  db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');

  // Insert
  db.exec('INSERT INTO test (name) VALUES ("hello")');

  // Select
  const result = db.exec('SELECT count(*) as count FROM test');
  console.log('Result:', JSON.stringify(result, null, 2));
  console.log('Result type:', typeof result);
  console.log('Result length:', result?.length);

  if (result && result.length > 0) {
    console.log('First row:', result[0]);
    console.log('Columns:', result[0].columns);
    console.log('Values:', result[0].values);
  }

  // Test export
  const exported = db.export();
  console.log('Export type:', exported.constructor.name);
  console.log('Export length:', exported.length);

  // Test close
  console.log('Close type:', typeof db.close);
  db.close();
  console.log('Closed successfully');

  // Test export after close
  try {
    db.export();
    console.log('Export after close: worked');
  } catch (e) {
    console.log('Export after close: failed -', e.message);
  }

  // Test close again
  try {
    db.close();
    console.log('Close again: worked');
  } catch (e) {
    console.log('Close again: failed -', e.message);
  }
}

test().catch(console.error);