const dbPath = require('path').join(require('os').tmpdir(), 'test.db');
const Database = require('./node_modules/sql.js/dist/sql-wasm.js').default;

console.log('SQL.js version: require worked');

const db1 = new Database();
console.log('db1 created');
console.log('db1 close type:', typeof db1.close);
console.log('db1 export type:', typeof db1.export);
console.log('db1 exec type:', typeof db1.exec);

db1.close();
console.log('db1 closed');

const db2 = new Database(undefined, { filePath: dbPath });
console.log('db2 created with filePath');
console.log('db2 close type:', typeof db2.close);
console.log('db2 export type:', typeof db2.export);

db2.close();
console.log('db2 closed');

if (require('fs').existsSync(dbPath)) {
  console.log('DB file exists');
  require('fs').unlinkSync(dbPath);
}