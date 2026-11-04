export function cpfDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export function isValidCpf(value: string): boolean {
  const cpf = cpfDigits(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const compute = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const check = (sum * 10) % 11;
    return check === 10 ? 0 : check;
  };
  return compute(9) === Number(cpf[9]) && compute(10) === Number(cpf[10]);
}

export function formatCpf(value: string): string {
  const cpf = cpfDigits(value);
  return cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
}
