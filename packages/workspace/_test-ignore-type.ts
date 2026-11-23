import IgnoreFactory from 'ignore';
type I = ReturnType<typeof IgnoreFactory>;
const i: I = IgnoreFactory();
console.log(typeof i.ignores);
