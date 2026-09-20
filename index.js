/**
 * WestJet | PTFS - Business Class Raffle Bot
 * -----------------------------------------------------
 * Staff starts a nightly raffle -> the bot secretly picks a number
 * from 1 to 50 -> members guess with /guess -> anyone who guesses the
 * right number instantly gets a unique redemption code in their DMs.
 * Staff ends the raffle whenever they want (reveals the number + winners).
 *
 * Redemption panel: staff posts a panel with a "Redeem Code" button.
 * Clicking it opens a form (no need to type in a channel) asking for
 * the code + Roblox username. On submit, it's posted straight to a
 * staff review channel with Confirm/Reject buttons - no chat spam.
 *
 * Slash commands:
 *   /raffle-start [min] [max]   (staff) - starts a new raffle
 *   /guess <number>             (anyone) - one guess per person per raffle
 *   /raffle-status              (staff) - shows how many people have guessed
 *   /raffle-end                 (staff) - ends the raffle, reveals number + winners
 *   /redeem <code>              (staff) - marks a code as redeemed directly
 *   /redeem-panel               (staff) - posts the "Redeem Code" button panel
 *
 * Data is stored in raffle.json and codes.json so it survives restarts.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField,
  REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;       // optional: where raffle open/close gets announced
const REDEEM_REVIEW_CHANNEL_ID = process.env.REDEEM_REVIEW_CHANNEL_ID; // where submitted codes get posted for staff

const BRAND_COLOR = 0x00885A;
const BRAND_GOLD = 0xF2A900;
const BRAND_DENY = 0xC8102E;
const CODES_FILE = path.join(__dirname, 'codes.json');
const RAFFLE_FILE = path.join(__dirname, 'raffle.json');

// ---- persistence helpers ----
const loadJSON = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

function loadCodes() { return loadJSON(CODES_FILE, {}); }
function saveCodes(codes) { saveJSON(CODES_FILE, codes); }

function loadRaffle() { return loadJSON(RAFFLE_FILE, null); }
function saveRaffle(raffle) { saveJSON(RAFFLE_FILE, raffle); }
function clearRaffle() { if (fs.existsSync(RAFFLE_FILE)) fs.unlinkSync(RAFFLE_FILE); }

// ---- helpers ----
function isStaff(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID)) return true;
  return false;
}

function generateCode() {
  // e.g. "RBNSDP1SX" - 10 uppercase letters/digits, easy to read out loud
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 to avoid confusion
  let code = '';
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function randomNumberInRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---- client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const commands = [
    new SlashCommandBuilder()
      .setName('raffle-start')
      .setDescription('Start a new Business Class raffle')
      .addIntegerOption((o) => o.setName('min').setDescription('Lowest possible number (default 1)').setMinValue(1))
      .addIntegerOption((o) => o.setName('max').setDescription('Highest possible number (default 50)').setMinValue(2))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('guess')
      .setDescription('Guess tonight\'s Business Class number')
      .addIntegerOption((o) => o.setName('number').setDescription('Your guess').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('raffle-status')
      .setDescription('(Staff) Check the current raffle status')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('raffle-end')
      .setDescription('(Staff) End the current raffle and reveal the number')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('redeem')
      .setDescription('(Staff) Mark a Business Class code as redeemed')
      .addStringOption((o) => o.setName('code').setDescription('The code the passenger gave you').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('redeem-panel')
      .setDescription('(Staff) Post the Business Class code redemption panel')
      .toJSON(),
  ];
  const rest = new REST().setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Error registering slash commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) return handleSlashCommand(interaction);
  if (interaction.isButton()) return handleButton(interaction);
  if (interaction.isModalSubmit()) return handleModalSubmit(interaction);
});

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  // ---- /raffle-start (staff) ----
  if (commandName === 'raffle-start') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '🚫 Staff only.', ephemeral: true });
    }
    if (loadRaffle()) {
      return interaction.reply({ content: '⚠️ A raffle is already running. Use `/raffle-end` first.', ephemeral: true });
    }

    const min = interaction.options.getInteger('min') ?? 1;
    const max = interaction.options.getInteger('max') ?? 50;
    if (min >= max) {
      return interaction.reply({ content: '⚠️ `min` must be smaller than `max`.', ephemeral: true });
    }

    const secretNumber = randomNumberInRange(min, max);
    saveRaffle({
      min, max, secretNumber,
      startedBy: interaction.user.tag,
      startedAt: new Date().toISOString(),
      guessedUsers: [], // userIds who already used their guess
      winners: [],      // { userId, tag, code, guessedAt }
    });

    const embed = new EmbedBuilder()
      .setTitle('🎟️  Business Class Raffle - OPEN!')
      .setDescription(
        `Guess tonight's secret number between **${min}** and **${max}** with \`/guess\`.\n\n` +
          'One guess per person. Guess right and you\'ll instantly get a **Business Class code** in your DMs!'
      )
      .setColor(BRAND_GOLD)
      .setTimestamp();

    await interaction.reply({ content: '✅ Raffle started!', ephemeral: true });

    if (ANNOUNCE_CHANNEL_ID) {
      const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
      if (channel) await channel.send({ embeds: [embed] });
    } else {
      await interaction.followUp({ embeds: [embed] });
    }
    return;
  }

  // ---- /guess (anyone) ----
  if (commandName === 'guess') {
    const raffle = loadRaffle();
    if (!raffle) {
      return interaction.reply({ content: '❌ There is no raffle running right now. Wait for staff to start one!', ephemeral: true });
    }

    if (raffle.guessedUsers.includes(interaction.user.id)) {
      return interaction.reply({ content: '⚠️ You already used your guess for this raffle. Wait for the next one!', ephemeral: true });
    }

    const guess = interaction.options.getInteger('number');
    if (guess < raffle.min || guess > raffle.max) {
      return interaction.reply({ content: `⚠️ Your guess must be between ${raffle.min} and ${raffle.max}.`, ephemeral: true });
    }

    raffle.guessedUsers.push(interaction.user.id);

    if (guess === raffle.secretNumber) {
      const code = generateCode();
      const codes = loadCodes();
      codes[code] = {
        userId: interaction.user.id,
        tag: interaction.user.tag,
        raffleStartedAt: raffle.startedAt,
        redeemed: false,
        wonAt: new Date().toISOString(),
      };
      saveCodes(codes);

      raffle.winners.push({ userId: interaction.user.id, tag: interaction.user.tag, code, guessedAt: new Date().toISOString() });
      saveRaffle(raffle);

      try {
        await interaction.user.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('🎉 You guessed it!')
              .setDescription(
                `You got tonight's number right! Here is your **Business Class code**:\n\n` +
                  `\`${code}\`\n\n` +
                  'Show this code to staff during check-in or boarding to redeem your seat.'
              )
              .setColor(BRAND_GOLD),
          ],
        });
        await interaction.reply({ content: '🎉 Correct! Check your DMs for your Business Class code.', ephemeral: true });
      } catch {
        await interaction.reply({
          content: "🎉 Correct! But I couldn't DM you your code - please enable your DMs and ask staff to resend it with `/redeem`.",
          ephemeral: true,
        });
      }
    } else {
      saveRaffle(raffle);
      await interaction.reply({ content: '❌ Not quite - better luck next time!', ephemeral: true });
    }
    return;
  }

  // ---- /raffle-status (staff) ----
  if (commandName === 'raffle-status') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '🚫 Staff only.', ephemeral: true });
    }
    const raffle = loadRaffle();
    if (!raffle) return interaction.reply({ content: 'No raffle is currently running.', ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle('🎟️  Raffle Status')
      .addFields(
        { name: 'Range', value: `${raffle.min} - ${raffle.max}`, inline: true },
        { name: 'Guesses so far', value: String(raffle.guessedUsers.length), inline: true },
        { name: 'Winners so far', value: String(raffle.winners.length), inline: true },
        { name: 'Started by', value: raffle.startedBy },
        { name: 'Started at', value: new Date(raffle.startedAt).toLocaleString() }
      )
      .setColor(BRAND_COLOR);
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ---- /raffle-end (staff) ----
  if (commandName === 'raffle-end') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '🚫 Staff only.', ephemeral: true });
    }
    const raffle = loadRaffle();
    if (!raffle) return interaction.reply({ content: 'No raffle is currently running.', ephemeral: true });

    const winnersList = raffle.winners.length
      ? raffle.winners.map((w) => `<@${w.userId}> (${w.tag}) — \`${w.code}\``).join('\n')
      : 'No one guessed it this time!';

    const embed = new EmbedBuilder()
      .setTitle('🎟️  Business Class Raffle - CLOSED')
      .setDescription(`The number was **${raffle.secretNumber}**.\n\n**Winners:**\n${winnersList}`)
      .setColor(BRAND_GOLD)
      .setTimestamp();

    clearRaffle();

    await interaction.reply({ content: '✅ Raffle ended.', ephemeral: true });
    if (ANNOUNCE_CHANNEL_ID) {
      const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
      if (channel) await channel.send({ embeds: [embed] });
    } else {
      await interaction.followUp({ embeds: [embed] });
    }
    return;
  }

  // ---- /redeem (staff) ----
  if (commandName === 'redeem') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '🚫 Staff only.', ephemeral: true });
    }
    const code = interaction.options.getString('code').trim().toUpperCase();
    const codes = loadCodes();
    const entry = codes[code];

    if (!entry) return interaction.reply({ content: '❌ That code does not exist.', ephemeral: true });
    if (entry.redeemed) {
      return interaction.reply({ content: `⚠️ That code was already redeemed on ${new Date(entry.redeemedAt).toLocaleString()}.`, ephemeral: true });
    }

    entry.redeemed = true;
    entry.redeemedAt = new Date().toISOString();
    entry.redeemedBy = interaction.user.tag;
    saveCodes(codes);

    return interaction.reply({ content: `✅ Code \`${code}\` redeemed for <@${entry.userId}> (${entry.tag}).`, ephemeral: true });
  }

  // ---- /redeem-panel (staff): posts the button panel ----
  if (commandName === 'redeem-panel') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '🚫 Staff only.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🎫  Business Class Code Redemption')
      .setDescription(
        'Won a Business Class code from the raffle? Click the button below to submit it.\n\n' +
          'You will be asked for your **code** and your **Roblox username** in a short form - ' +
          "no need to type anything in this channel. Staff will apply it on your next flight."
      )
      .setColor(BRAND_GOLD)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('redeem_open_modal').setLabel('Redeem Code').setEmoji('🎫').setStyle(ButtonStyle.Success)
    );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    return interaction.reply({ content: '✅ Redemption panel posted.', ephemeral: true });
  }
}

// ============================================================
// BUTTONS
// ============================================================
async function handleButton(interaction) {
  const { customId } = interaction;

  // ---- "Redeem Code" button -> opens the form ----
  if (customId === 'redeem_open_modal') {
    const modal = new ModalBuilder().setCustomId('redeem_modal').setTitle('Redeem Business Class Code');

    const codeInput = new TextInputBuilder()
      .setCustomId('redeem_code_input')
      .setLabel('Your Business Class code')
      .setPlaceholder('e.g. RBNSDP1SX')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10);

    const usernameInput = new TextInputBuilder()
      .setCustomId('redeem_username_input')
      .setLabel('Your Roblox username')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(30);

    modal.addComponents(
      new ActionRowBuilder().addComponents(codeInput),
      new ActionRowBuilder().addComponents(usernameInput)
    );

    return interaction.showModal(modal);
  }

  // ---- Staff confirms/rejects a submitted redemption ----
  if (customId.startsWith('redeemconfirm_') || customId.startsWith('redeemreject_')) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '🚫 Staff only.', ephemeral: true });
    }

    const code = customId.split('_')[1];
    const codes = loadCodes();
    const entry = codes[code];
    const approve = customId.startsWith('redeemconfirm_');

    if (!entry) {
      return interaction.update({ content: '❌ This code no longer exists.', embeds: [], components: [] });
    }

    if (approve) {
      entry.redeemed = true;
      entry.redeemedAt = new Date().toISOString();
      entry.redeemedBy = interaction.user.tag;
    }
    saveCodes(codes);

    const oldEmbed = interaction.message.embeds[0];
    const newEmbed = EmbedBuilder.from(oldEmbed)
      .setColor(approve ? BRAND_COLOR : BRAND_DENY)
      .setFooter({ text: `${approve ? '✅ Applied' : '❌ Rejected'} by ${interaction.user.tag}` });

    await interaction.update({ embeds: [newEmbed], components: [] });

    try {
      const passenger = await client.users.fetch(entry.userId);
      await passenger.send(
        approve
          ? `🎉 Your Business Class code \`${code}\` has been applied by staff. Enjoy your flight!`
          : `Your Business Class code \`${code}\` could not be verified by staff. Please contact them if you think this is a mistake.`
      );
    } catch {
      // ignore if DMs closed
    }
    return;
  }
}

// ============================================================
// MODAL SUBMISSIONS
// ============================================================
async function handleModalSubmit(interaction) {
  if (interaction.customId !== 'redeem_modal') return;

  const code = interaction.fields.getTextInputValue('redeem_code_input').trim().toUpperCase();
  const robloxUsername = interaction.fields.getTextInputValue('redeem_username_input').trim();

  const codes = loadCodes();
  const entry = codes[code];

  if (!entry) {
    return interaction.reply({ content: "❌ That code doesn't exist. Double check it and try again.", ephemeral: true });
  }
  if (entry.redeemed) {
    return interaction.reply({ content: '⚠️ That code has already been redeemed.', ephemeral: true });
  }
  if (entry.userId !== interaction.user.id) {
    return interaction.reply({ content: "❌ This code wasn't won by this Discord account, so it can't be redeemed here.", ephemeral: true });
  }

  entry.robloxUsername = robloxUsername;
  entry.submittedAt = new Date().toISOString();
  saveCodes(codes);

  const embed = new EmbedBuilder()
    .setTitle('🎫  New Redemption Request')
    .addFields(
      { name: 'Discord user', value: `<@${interaction.user.id}> (${interaction.user.tag})` },
      { name: 'Roblox username', value: robloxUsername },
      { name: 'Code', value: `\`${code}\`` }
    )
    .setColor(BRAND_GOLD)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`redeemconfirm_${code}`).setLabel('Apply').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`redeemreject_${code}`).setLabel('Reject').setEmoji('❌').setStyle(ButtonStyle.Danger)
  );

  if (REDEEM_REVIEW_CHANNEL_ID) {
    const channel = await client.channels.fetch(REDEEM_REVIEW_CHANNEL_ID).catch(() => null);
    if (channel) await channel.send({ embeds: [embed], components: [row] });
  }

  return interaction.reply({
    content: "✅ Submitted! Staff will apply your Business Class seat on your next flight.",
    ephemeral: true,
  });
}

client.login(TOKEN);

// fake HTTP server for Render's port check
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(process.env.PORT || 3000);
