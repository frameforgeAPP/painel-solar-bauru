# Manual de Instalação e Integração: Medidor Inteligente Tuya/Tasmota

Este guia compila todas as orientações técnicas para automatizar a leitura de dados de Importação (IMP) e Exportação (EXP) no seu PWA **Solar Monitor Pro**, utilizando o medidor inteligente bidirecional baseado no ecossistema Tuya.

---

## 1. O Hardware Correto

Para a sua rede bifásica da CPFL em Bauru (onde você possui duas fases de 127V no disjuntor principal de 63A), o hardware correto deve obrigatoriamente possuir **2 pinças de medição (CT Clamps)**.

* **Modelo Recomendado:** Medidor Inteligente Wi-Fi de Energia Bidirecional Tuya 2 Canais (Marca comum: *MatSee Plus*, *Ekaza*, *Loratap*).
* **Alerta de Compra:** No AliExpress ou Mercado Livre, evite a pegadinha da variação de 1 canal. Certifique-se de selecionar a opção **"2 Channels - 2CT"** (2 Canais / 2 Pinças de 80A ou 120A). A versão de 1 canal só monitorará metade da sua casa, resultando em dados incorretos de geração solar.

---

## 2. Guia de Instalação Física (Elétrica)

Abaixo está o esquema elétrico de conexões, baseado no disjuntor bipolar **Tramontina 63A** do seu padrão CPFL:

```
                  [ REDE ELÉTRICA CPFL (POSTE) ]
                                |
             +------------------+------------------+
             | (Fase A - Preto)                    | (Fase B - Preto)
             ▼                                     ▼
      [ Borne Superior L ]                  [ Borne Superior R ]
      +--------------------------------------------------------+
      |                                                        |
      |             DISJUNTOR PRINCIPAL BIPOLAR 63A            |
      |                                                        |
      +--------------------------------------------------------+
      [ Borne Inferior L ]                  [ Borne Inferior R ]
             |                                     |
             | (Fase A protegida)                  | (Fase B protegida)
             |                                     |
             +--------[ CT 1 / Pinça A ]           +--------[ CT 2 / Pinça B ]
             |                                     |
             ▼                                     ▼
      [ Ao QGD Interno da Casa ]            [ Ao QGD Interno da Casa ]
```

### ⚠️ Recomendações de Ouro para a Instalação:

1. **Localização do Medidor (Sinal Wi-Fi):** **Não instale o medidor dentro da caixa metálica externa da calçada.** A tampa de aço fecha uma Gaiola de Faraday, bloqueando o sinal de Wi-Fi. Efetue a instalação no seu **Quadro Geral de Distribuição (QGD) interno** de casa. As mesmas fases e neutro chegam lá e o sinal Wi-Fi será excelente.
2. **Alimentação do Aparelho (Bornes L e N):**
   * **Borne N (Neutro):** Conecte um fio fino (1,5 mm²) no barramento/cabo de **Neutro (Azul)**.
   * **Borne L (Fase):** Conecte um fio fino (1,5 mm²) em **qualquer uma das duas fases** na saída de um disjuntor interno. O aparelho ligará de forma segura em 127V estáveis.
3. **Sentido das Pinças (Direção da Seta):**
   * As duas pinças magnéticas possuem uma **seta física** gravada no plástico.
   * Instale as pinças de forma que a seta aponte **da rua em direção à casa** (do poste para os eletrodomésticos). Isso garante que o medidor saiba diferenciar a Importação (compra) da Exportação (injeção da energia gerada pelos microinversores).
   * Se algum canal registrar valores negativos por engano no aplicativo, basta abrir o clip e inverter a posição física da pinça no cabo.

---

## 3. Caminhos de Integração de Software

Uma vez instalado o medidor físico, você tem duas opções para conectá-lo ao seu aplicativo PWA:

### Opção A: Nuvem Tuya (Fácil, com Nuvem)
Usa o aplicativo Smart Life original e a API oficial da Tuya.
* **Fluxo de Dados:** Medidor ➔ Nuvem Tuya ➔ Firebase Cloud Function ➔ Firestore ➔ Seu PWA.
* **Como funciona:** Criamos um script em nuvem no seu Firebase que faz login automático na API de desenvolvedor da Tuya, lê o Import/Export atual do aparelho e salva na sua coleção `leituras` no Firestore.
* **Limitação:** A conta gratuita de desenvolvedor no portal `iot.tuya.com` expira a cada 6 meses, exigindo que você clique em "Renovar" no painel da Tuya de graça para manter o sistema ativo.

### Opção B: Tasmota / OpenBeken (Avançado, 100% Local e Livre)
Remove os servidores da Tuya instalando um sistema open-source no medidor por Wi-Fi.
* **Fluxo de Dados:** Medidor ➔ PWA (chamada direta de IP local na mesma rede Wi-Fi).
* **Como funciona:** Usando um computador com Wi-Fi, rodamos o script gratuito `tuya-cloudcutter` para enviar um firmware modificado via Wi-Fi ao medidor (sem solda e sem abrir o aparelho). O medidor se transforma em um dispositivo Tasmota/OpenBeken.
* **Como configurar no Tasmota:**
  No painel web do medidor, insira o seguinte **Template de Configuração** em `Configure Template` para ativar os sensores de corrente:
  ```json
  {"NAME":"MatSee Plus 2CH","GPIO":[0,0,0,0,0,0,0,3200,11329,32,544,0,0,0,0,0,0,0,1,0,0,0],"FLAG":0,"BASE":1,"CMND":"EnergyCols 2; SO129 1"}
  ```
  E execute os seguintes comandos no Console do Tasmota para habilitar a visualização individual e injeção solar:
  ```bash
  SetOption129 1         # Exibe a energia de cada canal separadamente
  EnergyExportActive 1   # Habilita a visualização de energia exportada (solar)
  SetOption21 1          # Habilita a leitura de tensão de rede
  ```

---

## 4. Próximos Passos no Aplicativo
Enquanto aguarda a entrega do seu medidor físico de 2 canais, a estrutura do seu PWA no `script.js` pode ser preparada com um **Modo de Simulação** para validar a leitura e gravação automáticas.
O modelo de dados do Firestore continuará consumindo a estrutura padrão existente:
```javascript
const reading = {
    date: new Date().toLocaleDateString('pt-BR'),
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    import: impValue,       // Calculado por: (FaseA.total + FaseB.total) / 1000
    export: expValue,       // Calculado por: (FaseA.returned + FaseB.returned) / 1000
    production: prodToSave,  // Consumido direto da API SolaX
    watts: state.wattsNow
};
```
