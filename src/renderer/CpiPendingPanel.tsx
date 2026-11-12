import type { CpiPendingRowId, CpiPendingWorkflowPage } from '../shared/types.ts';

interface Props {
  value:CpiPendingWorkflowPage|null;
  page:number;
  busy:boolean;
  canVerify:boolean;
  onPage:(page:number)=>void;
  onVerify:(ids:CpiPendingRowId)=>void;
  onRefresh:()=>void;
}

export function CpiPendingPanel({value,page,busy,canVerify,onPage,onVerify,onRefresh}:Props){
  return <section className="panel cpi-dashboard-panel" aria-labelledby="cpi-pending-title">
    <div className="panel-heading"><h2 id="cpi-pending-title">Pesquisas pendentes</h2>
      <p>Para verificar uma resposta CPI, abra manualmente o detalhe no Edge. Verificar apenas lê a resposta; não consulta a Deskdata, anexa PDF ou salva na CPI.</p></div>
    <div className="cpi-history-table" role="region" aria-label="Pendências CPI da conta" tabIndex={0}>
      <table><thead><tr><th>Pesquisa</th><th>Solicitação</th><th>Estágio</th><th>Motivo</th><th>Datas</th><th>Ação</th></tr></thead><tbody>
        {value?.items.map(item=><tr key={`${item.pesquisaId}-${item.solicitacaoId}`}>
          <td className="cpi-id">{item.pesquisaId}</td><td className="cpi-id">{item.solicitacaoId}</td>
          <td>{item.stage==='query_started'?'Consulta Deskdata incerta':item.stage}</td>
          <td>{item.stage==='query_started'?'Confira no histórico da Deskdata se a consulta foi cobrada antes de qualquer ação.':item.reviewReason??item.lastVerificationReason??(item.stage==='submit_started'?'Resultado remoto incerto':'Verificação necessária')}</td>
          <td>Atualizado: {new Date(item.updatedAt).toLocaleString('pt-BR')}{item.submittedAt?<><br/>Envio iniciado: {new Date(item.submittedAt).toLocaleString('pt-BR')}</>:null}{item.lastCheckedAt?<><br/>Verificado: {new Date(item.lastCheckedAt).toLocaleString('pt-BR')}</>:null}</td>
          <td>{item.stage==='query_started'?null:<button type="button" className="secondary" disabled={busy||!canVerify} onClick={()=>onVerify(item)}>Verificar detalhe aberto</button>}</td>
        </tr>)}
        {!value?.items.length?<tr><td colSpan={6} className="cpi-empty-history">Nenhuma pesquisa pendente nesta página.</td></tr>:null}
      </tbody></table>
    </div>
    <div className="actions"><span className="hint">{value?`${value.total} pendência(s) nesta conta · página ${value.page+1}`:'Carregando pendências...'}</span>
      <button type="button" className="secondary" disabled={busy||page===0} onClick={()=>onPage(page-1)}>Anterior</button>
      <button type="button" className="secondary" disabled={busy||!value||(page+1)*value.pageSize>=value.total} onClick={()=>onPage(page+1)}>Próxima</button>
      <button type="button" className="secondary" disabled={busy} onClick={onRefresh}>Atualizar</button>
    </div>
  </section>;
}
