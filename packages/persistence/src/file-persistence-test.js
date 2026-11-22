import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function test() {
  const dbPath = path.join(os.tmpdir(), 'test-persistence.db');
  
  // Clean up if exists
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  console.log('=== Test 1: Create database, insert data, export, write to file ===');
  
  const sqlModule = await initSqlJs();
  const Database = sqlModule.Database;
  const db = new Database();
  
  db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec('INSERT INTO test (name) VALUES ("hello")');
  
  const exported = db.export();
  console.log('Exported length:', exported.length);
  
  fs.writeFileSync(dbPath, exported);
  console.log('File written, size:', fs.statSync(dbPath).size);
  
  db.close();
  console.log('Database closed');
  
  console.log('\n=== Test 2: Load database from file, verify data ===');
  
  const sqlModule2 = await initSqlJs();
  const Database2 = sqlModule2.Database;
  
  const fileData = fs.readFileSync(dbPath);
  console.log('File read, length:', fileData.length);
  
  const db2 = new Database2(fileData);
  
  const result = db2.exec('SELECT count(*) as count FROM test');
  console.log('Result:', JSON.stringify(result, null, 2));
  console.log('Count:', result[0].values[0][0]);
  
  db2.close();
  console.log('Database 2 closed');
  
  // Clean up
  fs.unlinkSync(dbPath);
  console.log('\n=== Test complete ===');
}

test().catch(console.error);