/** Uma concessão do backend por job controlado; HTTP perdido nunca autoriza reenvio. */
async function obterConcessoes(lote, reivindicar) {
  for (const {job} of lote) {
    if (job.controle?.versao !== 1) continue;
    const autorizado = await reivindicar(job.job_uuid);
    if (!autorizado) throw new Error('O envio já foi iniciado ou não pôde ser autorizado. Confira o lote no Hub.');
  }
}
module.exports = { obterConcessoes };
