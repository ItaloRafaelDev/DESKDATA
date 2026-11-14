/**
 * Seletores do formulário "Responder / Atualizar Pesquisa" da CPI (iframe mod_tt_pesq_upd.aspx).
 * Origem: projeto AGENTE_PESQUISA_FORUM_NACIONAL (cpi-selectors.ts), em uso no portal real.
 * A Fonte 1º (`id_pesquisador_prim`) e "Nada Consta" (`#consta1`) nunca são alterados pelo agente.
 */
export const CPI_FORM = {
  source: 'select[name="id_pesquisador"]',
  status: 'select[name="id_pesq_status"]',
  resultInformation: '#consta2',
  resultRestrictions: '#consta3',
  /** Radios que o agente nunca deve deixar marcados. */
  resultForbidden: ['#consta1'],
  upload: '#MainPage_FileUpload1',
  save: 'form[name="form_cad"] a.button[onclick*="upd_pesq"]',
  sourceLabel: 'Desk Data',
  statusLabel: 'Respondida',
  keepOnScreenText: 'PERMANECER NESTA TELA',
  confirmMessage: /deseja\s+realmente\s+alterar\s+esta\s+pesquisa/i,
  loginPath: '/acesso/checkuser.aspx'
} as const;

export type CpiResultClassification = 'restrictions' | 'information';
export function resultSelectorFor(classification: CpiResultClassification): string {
  return classification === 'restrictions' ? CPI_FORM.resultRestrictions : CPI_FORM.resultInformation;
}
