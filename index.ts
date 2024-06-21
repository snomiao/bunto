import detective from 'detective-es6'
await Array.fromAsync(new Bun.Glob('*.ts').scan())
detective
