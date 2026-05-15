const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// Remover update-time do header
html = html.replace(/\s*<span id="update-time"[\s\S]*?<\/span>/, '');

// Extrair blocos
const getBlock = (startMarker, endMarker) => {
    const startIndex = html.indexOf(startMarker);
    const endIndex = html.indexOf(endMarker, startIndex) + endMarker.length;
    return html.substring(startIndex, endIndex);
};

const blockInversores = getBlock('<!-- IDENTIFICAÇÃO DOS INVERSORES -->', '</div>\r\n            </div>');
const blockGrafico = getBlock('<div class="card">\r\n                <div style="display: flex; justify-content: space-between', '</div>\r\n            </div>');
const blockTotais = getBlock('<!-- TOTAIS HISTÓRICOS -->', '</div>\r\n            </div>');
const blockTempo = getBlock('<!-- PREVISÃO DO TEMPO -->', '</div>\r\n            </div>');

// Nós precisamos ter certeza das tags de fim. Vamos usar expressões regulares seguras para remover os blocos originais
html = html.replace(/<!-- IDENTIFICAÇÃO DOS INVERSORES -->[\s\S]*?<div id="inverter-details"[\s\S]*?<\/div>\s*<\/div>/, '[[INVERSORES]]');
html = html.replace(/<div class="card">\s*<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">\s*<h3 style="margin-bottom: 0;"><i class="fas fa-chart-area"><\/i> Geração vs Consumo[\s\S]*?<\/canvas>\s*<\/div>\s*<\/div>/, '[[GRAFICO]]');
html = html.replace(/<!-- TOTAIS HISTÓRICOS -->[\s\S]*?id="val-total-imp"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '[[TOTAIS]]');
html = html.replace(/<!-- PREVISÃO DO TEMPO -->[\s\S]*?id="weather-forecast"[\s\S]*?<\/div>\s*<\/div>/, '[[TEMPO]]');

// Montando o Tempo com o update-time
const newTempoBlock = blockTempo.replace('</div>\r\n            </div>', `</div>\r\n                <div style="text-align: right; margin-top: 5px;">\r\n                    <span id="update-time" class="skeleton" style="font-size: 0.65rem; color: var(--text-light);"><i class="fas fa-sync"></i> Buscando dados...</span>\r\n                </div>\r\n            </div>`);

// Ordem final desejada: Diário (já está lá), Totais, Inversores, Grafico, Tempo
const novoLayout = `
            \${blockTotais}

            \${blockInversores}

            \${blockGrafico}

            \${newTempoBlock}
`;

// Inserir os blocos logo após o Diário
html = html.replace(/<div class="card main-flow">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, match => match + '\n[[LAYOUT]]');

// Agora substituimos as tags [[INVERSORES]], [[GRAFICO]], [[TOTAIS]], [[TEMPO]] por vazio
html = html.replace('[[INVERSORES]]', '');
html = html.replace('[[GRAFICO]]', '');
html = html.replace('[[TOTAIS]]', '');
html = html.replace('[[TEMPO]]', '');

// Substituimos o [[LAYOUT]] com o layout reordenado
html = html.replace('[[LAYOUT]]', `
            <!-- TOTAIS HISTÓRICOS -->
            <div class="card">
                <h3><i class="fas fa-award"></i> Totais Desde a Instalação</h3>
                <div class="input-grid" style="grid-template-columns: 1fr 1fr 1fr; margin-bottom: 0; gap: 5px;">
                    <div class="node solar" style="background: var(--bg); padding: 10px 5px; border-radius: 10px; width: 100%; box-sizing: border-box;">
                        <span class="label" style="color: #27ae60; font-size: 0.55rem;">Uso do Sol</span>
                        <span class="value skeleton" id="val-total-uso" style="font-size: 0.85rem;">0 <small>kWh</small></span>
                    </div>
                    <div class="node solar" style="background: var(--bg); padding: 10px 5px; border-radius: 10px; width: 100%; box-sizing: border-box;">
                        <span class="label" style="color: #d35400; font-size: 0.55rem;">Exportado</span>
                        <span class="value skeleton" id="val-total-exp" style="font-size: 0.85rem;">0 <small>kWh</small></span>
                    </div>
                    <div class="node home" style="background: var(--bg); padding: 10px 5px; border-radius: 10px; width: 100%; box-sizing: border-box;">
                        <span class="label" style="color: #3498db; font-size: 0.55rem;">Compra CPFL</span>
                        <span class="value skeleton" id="val-total-imp" style="font-size: 0.85rem;">0 <small>kWh</small></span>
                    </div>
                </div>
            </div>

            <!-- IDENTIFICAÇÃO DOS INVERSORES -->
            <div class="card">
                <h3><i class="fas fa-microchip"></i> Identificação dos Microinversores</h3>
                <div id="inverter-details" class="inverter-list">
                    <!-- Preenchido via script.js -->
                </div>
            </div>

            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <h3 style="margin-bottom: 0;"><i class="fas fa-chart-area"></i> Geração vs Consumo</h3>
                    <div class="chart-tabs">
                        <button id="tab-bar-btn" class="tab-btn active" onclick="switchChartTab('bar')"><i class="fas fa-chart-bar"></i> Barras</button>
                        <button id="tab-line-btn" class="tab-btn" onclick="switchChartTab('line')"><i class="fas fa-chart-line"></i> Linhas</button>
                    </div>
                </div>
                <div class="chart-container" id="chart-bar-container" style="position: relative; height:180px; width:100%">
                    <canvas id="energyChart"></canvas>
                </div>
                <div class="chart-container" id="chart-line-container" style="position: relative; height:180px; width:100%; display: none;">
                    <canvas id="energyChartLine"></canvas>
                </div>
            </div>

            <!-- PREVISÃO DO TEMPO -->
            <div class="card">
                <h3><i class="fas fa-cloud-sun"></i> Previsão do Tempo (Bauru)</h3>
                <div id="weather-forecast" style="display: flex; justify-content: space-between; gap: 8px; overflow-x: auto; padding-bottom: 5px;">
                    <div class="skeleton" style="min-width: 60px; height: 80px; border-radius: 8px;"></div>
                    <div class="skeleton" style="min-width: 60px; height: 80px; border-radius: 8px;"></div>
                    <div class="skeleton" style="min-width: 60px; height: 80px; border-radius: 8px;"></div>
                    <div class="skeleton" style="min-width: 60px; height: 80px; border-radius: 8px;"></div>
                    <div class="skeleton" style="min-width: 60px; height: 80px; border-radius: 8px;"></div>
                </div>
                <div style="text-align: right; margin-top: 8px;">
                    <span id="update-time" class="skeleton" style="font-size: 0.65rem; color: var(--text-light);"><i class="fas fa-sync"></i> Buscando dados...</span>
                </div>
            </div>
`);

fs.writeFileSync('index.html', html.replace(/\n\s*\n/g, '\n\n'));
