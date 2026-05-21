const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

// Inicializa o Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Configurações SolaX
const SOLAX_TOKEN = '202605120608478230237210';
const DEVICES = [
    { sn: 'C02711021F3193', name: 'Micro Inv. 1 (Micro-4in1)' },
    { sn: 'C02711021F312R', name: 'Micro Inv. 2 (Micro-4in1)' }
];

/**
 * Realiza a chamada à API do SolaX com tentativas (retry) em caso de falha.
 * Como rodamos no servidor, não há necessidade de proxies CORS.
 */
async function fetchInverterWithRetry(sn, tokenId, retries = 3, delayMs = 2000) {
    const url = `https://www.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${tokenId}&sn=${sn}&t=${Date.now()}`;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            logger.info(`[Solax SN: ${sn}] Tentativa ${attempt} de busca de dados...`);
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data && data.success) {
                return data.result;
            } else {
                throw new Error(data.exception || "API respondeu com success=false");
            }
        } catch (err) {
            logger.warn(`[Solax SN: ${sn}] Tentativa ${attempt} falhou: ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

/**
 * Cloud Function Agendada (Cron)
 * Roda a cada 5 minutos, das 06:00 às 20:55 (fuso horário America/Sao_Paulo)
 */
exports.syncSolaxToFirestore = onSchedule({
    schedule: "*/5 6-20 * * *",
    timeZone: "America/Sao_Paulo",
    memory: "256MiB",
    timeoutSeconds: 60
}, async (event) => {
    logger.info("Iniciando execução da Cloud Function syncSolaxToFirestore...");

    const todayStr = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    logger.info(`Data calculada no fuso de São Paulo: ${todayStr}`);

    // 1. Consultar ambos os inversores em paralelo com Promise.allSettled
    const results = await Promise.allSettled(
        DEVICES.map(dev => fetchInverterWithRetry(dev.sn, SOLAX_TOKEN))
    );

    let totalYield = 0;
    let totalWatts = 0;
    let successCount = 0;

    results.forEach((r, index) => {
        const devName = DEVICES[index].name;
        const devSn = DEVICES[index].sn;
        if (r.status === 'fulfilled' && r.value) {
            const watts = Number(r.value.acpower || r.value.acPower || 0);
            const yDay = Number(r.value.yieldtoday || r.value.yieldToday || 0);
            
            totalYield += yDay;
            totalWatts += watts;
            successCount++;
            
            logger.info(`[Solax] Inversor ${index + 1} (${devName}): ${watts}W | Hoje: ${yDay}kWh`);
        } else {
            const errorMsg = r.status === 'rejected' ? r.reason.message : 'Sem dados válidos';
            logger.error(`[Solax] Falha ao obter dados do Inversor ${index + 1} (${devSn}): ${errorMsg}`);
        }
    });

    // 2. Só prossegue com a gravação se AMBOS os inversores responderam com sucesso para evitar dados parciais corruptos
    if (successCount !== DEVICES.length) {
        logger.warn(`[Solax] Apenas ${successCount} de ${DEVICES.length} inversores responderam. Cancelando gravação para evitar distorção nas somas.`);
        return;
    }

    try {
        // 3. Buscar o último documento da coleção "leituras" para herdar dados acumulados da CPFL
        const leiturasCol = db.collection("leituras");
        const snapshot = await leiturasCol.orderBy("timestamp", "desc").limit(1).get();

        let lastImport = 0;
        let lastExport = 0;
        let lastProduction = 0;
        let lastDate = "";

        if (!snapshot.empty) {
            const lastDoc = snapshot.docs[0].data();
            lastImport = Number(lastDoc.import) || 0;
            lastExport = Number(lastDoc.export) || 0;
            lastProduction = Number(lastDoc.production) || 0;
            lastDate = lastDoc.date || "";
            
            logger.info(`Dados herdados da última leitura (${lastDate}): import: ${lastImport} | export: ${lastExport} | prod: ${lastProduction}`);
        } else {
            logger.warn("A coleção 'leituras' está vazia. Não há histórico para herdar leituras da CPFL.");
        }

        // 4. Lógica de Proteção contra Lag SolaX (se a geração é a mesma do dia anterior e não há sol, assume 0)
        let prodToSave = totalYield;
        if (lastDate !== "" && lastDate !== todayStr) {
            if (prodToSave === lastProduction && totalWatts === 0) {
                logger.info(`[Lag Protect] Detectada leitura de ontem acumulada. Zerando geração do início do dia.`);
                prodToSave = 0;
            }
        }

        // 5. Preparar e gravar o novo documento
        const reading = {
            date: todayStr,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            import: lastImport,
            export: lastExport,
            production: Number(prodToSave.toFixed(2)),
            watts: totalWatts
        };

        const docRef = await leiturasCol.add(reading);
        logger.info(`[Sucesso] Leitura gravada com sucesso! ID: ${docRef.id} | watts: ${totalWatts}W | prod: ${prodToSave}kWh`);

    } catch (err) {
        logger.error(`Erro ao interagir com o Firestore ou processar gravação: ${err.message}`, err);
    }
});
