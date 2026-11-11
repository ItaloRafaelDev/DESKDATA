import type { Frame, Locator, Page } from 'playwright-core';

/** Caminho observado na barra de endereços da CPI; não é endpoint de API. */
export const CPI_PENDING_URL = 'https://adm.cpicentral.com.br/zpersEspecial/pesquisas/aguardando/mod_t_aguardando.aspx';
export const CPI_PERSON_TYPE_ID = '29';
const CPI_HOST = 'adm.cpicentral.com.br';

export interface CpiPendingFilterResult {
  typeId: '29';
  total: number | null;
  state: 'empty' | 'found' | 'unconfirmed';
}

/** O rodapé é a única informação extraída da listagem nesta fase; nunca traz dados pessoais. */
export function parseCpiListingCount(text: string): number | null {
  // Exemplo observado: "Mostrando: 0 à 0 ( de 0 registro )".
  const match = text.match(/Mostrando\s*:\s*[\d.,]+\s*(?:à|a|-)\s*[\d.,]+\s*\(\s*de\s*([\d.,]+)\s*registros?\s*\)/i);
  if (!match) return null;
  const digits = match[1].replace(/[.,]/g, '');
  if (!/^\d{1,12}$/.test(digits)) return null;
  const count = Number(digits);
  return Number.isSafeInteger(count) ? count : null;
}

function isCpiFrame(frame: Frame): boolean {
  try { return new URL(frame.url()).hostname === CPI_HOST; } catch { return false; }
}

async function visibleControl(page: Page, selector: string, timeoutMs = 12000): Promise<{ frame: Frame; locator: Locator }> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of page.frames().filter(isCpiFrame)) {
      const locator = frame.locator(selector).first();
      try { if (await locator.isVisible()) return { frame, locator }; } catch { /* Frame pode navegar durante a inspeção. */ }
    }
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  throw new Error(`Controle esperado não encontrado na CPI: ${selector}`);
}

/**
 * Checkbox personalizado do modal CPI: o iframe pode manter o input fora do viewport,
 * mesmo quando a linha correspondente está visível. `locator.check()` tenta um clique
 * por coordenadas e falha nesse cenário. `input.click()` é um clique DOM nativo,
 * disparando os handlers click/change do portal sem depender da posição na tela.
 * Nunca definir `checked` diretamente: isso ignoraria os handlers da CPI.
 */
export async function setCpiFilterCheckbox(locator: Locator, desired: boolean): Promise<void> {
  if (await locator.isChecked() === desired) return;
  const afterClick = await locator.evaluate((element, expected) => {
    const checkbox = element as HTMLInputElement;
    if (checkbox.tagName !== 'INPUT' || checkbox.type !== 'checkbox' || checkbox.disabled) {
      throw new Error('Controle de filtro CPI ausente, inválido ou desabilitado.');
    }
    if (checkbox.checked !== expected) checkbox.click();
    return checkbox.checked;
  }, desired);
  if (afterClick !== desired || await locator.isChecked() !== desired) {
    throw new Error('A CPI não confirmou a seleção do tipo de pesquisa.');
  }
}

export async function readListingCount(page: Page, timeoutMs = 25000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of page.frames().filter(isCpiFrame)) {
      try {
        // Somente a frase do rodapé cruza a fronteira do navegador; linhas com CPF nunca são coletadas.
        const summary = await frame.evaluate(() => {
          return document.body?.innerText.match(/Mostrando\s*:\s*[\d.,]+\s*(?:à|a|-)\s*[\d.,]+\s*\(\s*de\s*[\d.,]+\s*registros?\s*\)/i)?.[0] ?? null;
        });
        if (summary) {
          const count = parseCpiListingCount(summary);
          if (count !== null) return count;
        }
      } catch { /* A listagem pode ser substituída por uma navegação interna. */ }
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return null;
}

/**
 * Fase 2: altera apenas controles de FILTRO da listagem, sem abrir solicitações,
 * consultar CPFs ou modificar registros CPI. Exige login realizado manualmente.
 */
export async function filterPendingPerson29(page: Page): Promise<CpiPendingFilterResult> {
  const current = new URL(page.url());
  if (current.hostname !== CPI_HOST) throw new Error('Navegador não está no domínio administrativo CPI.');

  if (current.pathname.toLowerCase() !== new URL(CPI_PENDING_URL).pathname.toLowerCase()) {
    await page.goto(CPI_PENDING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  if (new URL(page.url()).hostname !== CPI_HOST) throw new Error('Sessão CPI inválida ou redirecionamento inesperado.');

  // Botão observado no DOM: <i title="Filtros Avançados" ... onclick="set_tipo_pesq();">
  const advanced = await visibleControl(page, '[title="Filtros Avançados"]');
  await advanced.locator.click({ timeout: 10000 });

  // Modal de tipos: pode estar em outro iframe CPI. Nunca depende de coordenadas nem de frame index.
  const { frame, locator: type29 } = await visibleControl(page, 'input#id_tipo_pesq_29[type="checkbox"]');
  const typeValue = await type29.getAttribute('value');
  if (!typeValue || typeValue.split(',')[0].trim() !== '29') {
    throw new Error('O checkbox identificado não corresponde ao tipo CPI 29.');
  }
  const options = frame.locator('input[type="checkbox"][id^="id_tipo_pesq_"]');
  const length = await options.count();
  if (length < 1) throw new Error('Não foi possível conferir o conjunto de tipos CPI.');

  // Garantir filtro EXCLUSIVO: remover quaisquer tipos previamente selecionados.
  for (let index = 0; index < length; index++) {
    const checkbox = options.nth(index);
    const id = await checkbox.getAttribute('id');
    if (id !== 'id_tipo_pesq_29' && await checkbox.isChecked()) await setCpiFilterCheckbox(checkbox, false);
  }
  await setCpiFilterCheckbox(type29, true);
  const checked = await options.evaluateAll(nodes => nodes.filter(node => (node as HTMLInputElement).checked).map(node => node.id));
  if (checked.length !== 1 || checked[0] !== 'id_tipo_pesq_29') {
    throw new Error('Não foi possível garantir a seleção exclusiva do tipo 29.');
  }

  // Botão confirmado no DOM: <a class="button" onclick="javascript:set();">Selecionar</a>.
  await frame.getByRole('link', { name: 'Selecionar', exact: true }).click({ timeout: 10000 });

  // Botão confirmado no DOM: <i title="Mostrar Tudo" onclick="...texto_change(1,0);">
  const showAll = await visibleControl(page, '[title="Mostrar Tudo"]', 15000);
  await showAll.locator.click({ timeout: 15000 });

  // O retorno 0 é uma listagem vazia válida; ausência do rodapé não vira falso 0.
  const total = await readListingCount(page);
  return { typeId: '29', total, state: total === null ? 'unconfirmed' : total === 0 ? 'empty' : 'found' };
}
