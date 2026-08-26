#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use eframe::egui::{self, Color32, RichText};
use reqwest::blocking::Client;
use serde::Deserialize;
use std::sync::mpsc::{self, Receiver};
use std::thread;

const PRODUCTION_SERVER_URL: &str = "https://lolihentai.online";
const ASYNC_TASK_POLL_MS: u64 = 50;

#[derive(Clone, Debug, Deserialize)]
struct User {
    id: String,
    username: String,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct Session {
    token: String,
    user: User,
}

#[derive(Clone, Debug, Deserialize)]
struct Guild {
    id: String,
    name: String,
    #[serde(default)]
    icon: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct Channel {
    id: String,
    name: String,
    #[serde(default)]
    r#type: i32,
}

#[derive(Clone, Debug, Deserialize)]
struct MessageAuthor {
    username: String,
}

#[derive(Clone, Debug, Deserialize)]
struct Message {
    id: String,
    content: String,
    #[serde(default)]
    author: Option<MessageAuthor>,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct GuildSnapshot {
    #[serde(default)]
    channels: Vec<Channel>,
}

enum TaskResult {
    Login(Session),
    Register(Session),
    Guilds(Vec<Guild>),
    Guild(GuildSnapshot),
    Messages(Vec<Message>),
    Sent,
}

struct NativeClient {
    email: String,
    username: String,
    password: String,
    message_input: String,
    auth_error: String,
    task: Option<Receiver<Result<TaskResult, String>>>,
    session: Option<Session>,
    guilds: Vec<Guild>,
    channels: Vec<Channel>,
    messages: Vec<Message>,
    active_guild: Option<usize>,
    active_channel: Option<usize>,
    register_mode: bool,
    search_query: String,
    client: Client,
}

impl NativeClient {
    fn new() -> Self {
        let client = Client::builder()
            .cookie_store(true)
            .user_agent("Discord Alt Native/1.0")
            .build()
            .expect("failed to create HTTP client");
        Self {
            email: String::new(), username: String::new(),
            password: String::new(), message_input: String::new(), auth_error: String::new(),
            task: None, session: None, guilds: Vec::new(), channels: Vec::new(),
            messages: Vec::new(), active_guild: None, active_channel: None,
            register_mode: false, search_query: String::new(), client,
        }
    }

    fn endpoint(&self, path: &str) -> Result<String, String> {
        Ok(format!("{}{}", PRODUCTION_SERVER_URL, path))
    }

    fn spawn<F>(&mut self, work: F)
    where
        F: FnOnce() -> Result<TaskResult, String> + Send + 'static,
    {
        let (sender, receiver) = mpsc::channel();
        self.task = Some(receiver);
        thread::spawn(move || { let _ = sender.send(work()); });
    }

    fn sign_in(&mut self) {
        self.auth_error.clear();
        let endpoint = match self.endpoint(if self.register_mode { "/api/auth/register" } else { "/api/auth/login" }) {
            Ok(value) => value,
            Err(error) => { self.auth_error = error; return; }
        };
        if self.email.trim().is_empty() || self.password.is_empty() {
            self.auth_error = "Заполните email и пароль".to_string();
            return;
        }
        if self.register_mode && self.username.trim().len() < 3 {
            self.auth_error = "Имя пользователя должно быть не короче 3 символов".to_string();
            return;
        }
        let client = self.client.clone();
        let email = self.email.trim().to_string();
        let password = self.password.clone();
        let username = self.username.trim().to_string();
        let register = self.register_mode;
        self.spawn(move || {
            let mut body = serde_json::json!({ "email": email, "password": password });
            if register { body["username"] = serde_json::Value::String(username); }
            let response = client.post(endpoint).json(&body).send().map_err(|e| e.to_string())?;
            let status = response.status();
            let value: serde_json::Value = response.json().map_err(|e| e.to_string())?;
            if !status.is_success() { return Err(value["error"].as_str().unwrap_or("Ошибка авторизации").to_string()); }
            let session: Session = serde_json::from_value(value).map_err(|e| e.to_string())?;
            Ok(if register { TaskResult::Register(session) } else { TaskResult::Login(session) })
        });
    }

    fn load_guilds(&mut self) {
        let endpoint = match self.endpoint("/api/guilds/@me") { Ok(value) => value, Err(_) => return };
        let client = self.client.clone();
        let token = self.session.as_ref().map(|session| session.token.clone()).unwrap_or_default();
        self.spawn(move || {
            let response = client.get(endpoint).bearer_auth(token).send().map_err(|e| e.to_string())?;
            if !response.status().is_success() { return Err("Не удалось загрузить серверы".to_string()); }
            Ok(TaskResult::Guilds(response.json().map_err(|e| e.to_string())?))
        });
    }

    fn load_guild(&mut self, id: String) {
        let endpoint = match self.endpoint(&format!("/api/guilds/{id}")) { Ok(value) => value, Err(_) => return };
        let client = self.client.clone();
        let token = self.session.as_ref().map(|session| session.token.clone()).unwrap_or_default();
        self.spawn(move || {
            let response = client.get(endpoint).bearer_auth(token).send().map_err(|e| e.to_string())?;
            if !response.status().is_success() { return Err("Не удалось загрузить каналы".to_string()); }
            Ok(TaskResult::Guild(response.json().map_err(|e| e.to_string())?))
        });
    }

    fn load_messages(&mut self, id: String) {
        let endpoint = match self.endpoint(&format!("/api/channels/{id}/messages?limit=50")) { Ok(value) => value, Err(_) => return };
        let client = self.client.clone();
        let token = self.session.as_ref().map(|session| session.token.clone()).unwrap_or_default();
        self.spawn(move || {
            let response = client.get(endpoint).bearer_auth(token).send().map_err(|e| e.to_string())?;
            if !response.status().is_success() { return Err("Не удалось загрузить сообщения".to_string()); }
            Ok(TaskResult::Messages(response.json().map_err(|e| e.to_string())?))
        });
    }

    fn send_message(&mut self) {
        let Some(channel) = self.active_channel.and_then(|index| self.channels.get(index)) else { return };
        let content = self.message_input.trim().to_string();
        if content.is_empty() { return; }
        let endpoint = match self.endpoint(&format!("/api/channels/{}/messages", channel.id)) { Ok(value) => value, Err(error) => { self.auth_error = error; return; } };
        let client = self.client.clone();
        let token = self.session.as_ref().map(|session| session.token.clone()).unwrap_or_default();
        self.message_input.clear();
        self.spawn(move || {
            let response = client.post(endpoint).bearer_auth(token).json(&serde_json::json!({ "content": content })).send().map_err(|e| e.to_string())?;
            if !response.status().is_success() { return Err("Не удалось отправить сообщение".to_string()); }
            Ok(TaskResult::Sent)
        });
    }

    fn handle_task(&mut self) {
        let Some(task) = self.task.as_ref() else { return };
        let Ok(result) = task.try_recv() else { return };
        self.task = None;
        match result {
            Ok(TaskResult::Login(session)) | Ok(TaskResult::Register(session)) => { self.session = Some(session); self.load_guilds(); }
            Ok(TaskResult::Guilds(guilds)) => { self.guilds = guilds; if !self.guilds.is_empty() { self.active_guild = Some(0); self.load_guild(self.guilds[0].id.clone()); } }
            Ok(TaskResult::Guild(snapshot)) => { self.channels = snapshot.channels.into_iter().filter(|channel| channel.r#type == 0).collect(); self.active_channel = None; self.messages.clear(); if !self.channels.is_empty() { self.active_channel = Some(0); self.load_messages(self.channels[0].id.clone()); } }
            Ok(TaskResult::Messages(messages)) => self.messages = messages,
            Ok(TaskResult::Sent) => { if let Some(channel) = self.active_channel.and_then(|index| self.channels.get(index)) { self.load_messages(channel.id.clone()); } }
            Err(error) => self.auth_error = error,
        }
    }

    fn logout(&mut self) {
        self.session = None;
        self.guilds.clear();
        self.channels.clear();
        self.messages.clear();
        self.active_guild = None;
        self.active_channel = None;
        self.message_input.clear();
    }

    fn login_view(&mut self, ui: &mut egui::Ui) {
        ui.vertical_centered(|ui| {
            ui.add_space(42.0);
            egui::Frame::NONE.fill(Color32::from_rgb(29, 36, 49)).stroke(egui::Stroke::new(1.0_f32, Color32::from_rgb(57, 68, 87))).corner_radius(14.0).inner_margin(0.0).show(ui, |ui| {
                ui.set_max_width(820.0);
                ui.horizontal(|ui| {
                    egui::Frame::NONE.fill(Color32::from_rgb(38, 48, 65)).inner_margin(30.0).show(ui, |ui| {
                        ui.set_min_size(egui::vec2(330.0, 430.0));
                        ui.vertical(|ui| {
                            ui.add_space(10.0);
                            ui.label(RichText::new("DISCORD ALT").small().strong().color(Color32::from_rgb(143, 157, 255)));
                            ui.add_space(38.0);
                            ui.label(RichText::new(if self.register_mode { "Ваше пространство начинается здесь." } else { "Все разговоры. Один спокойный клиент." }).size(27.0).strong());
                            ui.add_space(14.0);
                            ui.label(RichText::new("Подключайтесь к своему серверу напрямую. Без рекламы, лишних экранов и сторонних аккаунтов.").color(Color32::from_rgb(164, 174, 191)));
                            ui.add_space(28.0);
                            for (symbol, text) in [("+", "быстрый native-клиент"), ("#", "каналы и сообщения"), ("/", "ваш сервер и ваши данные")] {
                                ui.horizontal(|ui| { ui.label(RichText::new(symbol).size(18.0).strong().color(Color32::from_rgb(126, 143, 255))); ui.label(RichText::new(text).color(Color32::from_rgb(192, 200, 213))); });
                                ui.add_space(10.0);
                            }
                        });
                    });
                    egui::Frame::NONE.inner_margin(30.0).show(ui, |ui| {
                        ui.set_min_size(egui::vec2(420.0, 430.0));
                        ui.vertical(|ui| {
                            ui.add_space(10.0);
                            ui.label(RichText::new(if self.register_mode { "Создать аккаунт" } else { "Войти" }).size(24.0).strong());
                             ui.label(RichText::new(if self.register_mode { "Заполните данные для нового аккаунта." } else { "Введите данные для подключения." }).color(Color32::from_rgb(145, 157, 179)));
                             ui.add_space(24.0);
                             ui.label(RichText::new("EMAIL").small().strong().color(Color32::from_rgb(145, 157, 255)));
                            ui.add(egui::TextEdit::singleline(&mut self.email).hint_text("name@example.com").desired_width(f32::INFINITY));
                            if self.register_mode { ui.add_space(12.0); ui.label(RichText::new("ИМЯ ПОЛЬЗОВАТЕЛЯ").small().strong().color(Color32::from_rgb(145, 157, 255))); ui.add(egui::TextEdit::singleline(&mut self.username).hint_text("username").desired_width(f32::INFINITY)); }
                            ui.add_space(12.0);
                            ui.label(RichText::new("ПАРОЛЬ").small().strong().color(Color32::from_rgb(145, 157, 255)));
                            ui.add(egui::TextEdit::singleline(&mut self.password).password(true).desired_width(f32::INFINITY));
                            ui.add_space(16.0);
                            if !self.auth_error.is_empty() { ui.colored_label(Color32::from_rgb(255, 125, 132), &self.auth_error); ui.add_space(6.0); }
                            let label = if self.task.is_some() { "Подключение..." } else if self.register_mode { "Создать аккаунт" } else { "Войти" };
                            let button = ui.add_sized([ui.available_width(), 40.0], egui::Button::new(RichText::new(label).strong()).fill(Color32::from_rgb(91, 111, 235)));
                            if button.clicked() && self.task.is_none() { self.sign_in(); }
                            ui.add_space(12.0);
                            if ui.link(if self.register_mode { "Уже есть аккаунт? Войти" } else { "Нет аккаунта? Создать" }).clicked() { self.register_mode = !self.register_mode; self.auth_error.clear(); }
                        });
                    });
                });
            });
            ui.add_space(12.0);
             ui.label(RichText::new("Данные передаются напрямую на production-сервер.").small().color(Color32::from_rgb(105, 117, 137)));
        });
    }

    fn workspace_view(&mut self, ui: &mut egui::Ui) {
        let user_name = self.session.as_ref().map(|session| session.user.display_name.as_deref().unwrap_or(&session.user.username).to_string()).unwrap_or_default();
        egui::TopBottomPanel::top("workspace_topbar").exact_height(58.0).show_inside(ui, |ui| {
            ui.horizontal_centered(|ui| {
                ui.label(RichText::new("DISCORD ALT").strong().color(Color32::from_rgb(132, 147, 255)));
                ui.separator();
                ui.add(egui::TextEdit::singleline(&mut self.search_query).hint_text("Поиск по каналам").desired_width(230.0));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Выйти").clicked() { self.logout(); }
                    let color = if self.task.is_some() { Color32::from_rgb(240, 190, 90) } else { Color32::from_rgb(90, 205, 145) };
                    ui.label(RichText::new(if self.task.is_some() { "● syncing" } else { "● online" }).small().color(color));
                });
            });
        });
        egui::SidePanel::left("servers").resizable(false).default_width(76.0).show_inside(ui, |ui| {
            ui.vertical_centered(|ui| { ui.add_space(6.0); ui.label(RichText::new("DA").size(20.0).strong().color(Color32::from_rgb(132, 147, 255))); ui.separator(); });
            for (index, guild) in self.guilds.clone().iter().enumerate() {
                let selected = self.active_guild == Some(index);
                let icon = guild.name.chars().next().unwrap_or('?').to_uppercase().to_string();
                if ui.add_sized([52.0, 48.0], egui::Button::new(RichText::new(icon).size(17.0).strong()).fill(if selected { Color32::from_rgb(91, 111, 235) } else { Color32::from_rgb(47, 57, 73) })).on_hover_text(&guild.name).clicked() { self.active_guild = Some(index); self.load_guild(guild.id.clone()); }
            }
        });
        egui::SidePanel::left("channels").resizable(false).default_width(215.0).show_inside(ui, |ui| {
            ui.add_space(8.0);
            ui.label(RichText::new(self.active_guild.and_then(|index| self.guilds.get(index)).map(|guild| guild.name.as_str()).unwrap_or("Личные сообщения")).size(18.0).strong());
            ui.separator();
            ui.label(RichText::new("TEXT CHANNELS").small().strong().color(Color32::from_rgb(135, 147, 169)));
            for (index, channel) in self.channels.clone().iter().enumerate() {
                if !self.search_query.trim().is_empty() && !channel.name.to_lowercase().contains(&self.search_query.to_lowercase()) { continue; }
                if ui.selectable_label(self.active_channel == Some(index), RichText::new(format!("#  {}", channel.name)).size(15.0)).clicked() { self.active_channel = Some(index); self.load_messages(channel.id.clone()); }
            }
            ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| { ui.separator(); ui.label(RichText::new(format!("●  {user_name}")).small().color(Color32::from_rgb(90, 205, 145))); });
        });
        egui::CentralPanel::default().show_inside(ui, |ui| {
            let channel_name = self.active_channel.and_then(|index| self.channels.get(index)).map(|channel| channel.name.as_str()).unwrap_or("Выберите канал");
            ui.add_space(8.0);
            ui.horizontal(|ui| { ui.label(RichText::new(format!("#  {channel_name}")).size(19.0).strong()); ui.label(RichText::new("Текстовый канал для спокойного общения").small().color(Color32::from_rgb(130, 143, 165))); });
            ui.separator();
            egui::ScrollArea::vertical().stick_to_bottom(true).show(ui, |ui| {
                for message in &self.messages { egui::Frame::NONE.inner_margin(egui::Margin::symmetric(10, 8)).show(ui, |ui| { ui.horizontal_wrapped(|ui| { ui.label(RichText::new(message.author.as_ref().map(|author| author.username.as_str()).unwrap_or("user")).strong().color(Color32::from_rgb(148, 163, 255))); ui.label(&message.content); }); }); }
            });
            ui.separator();
            ui.horizontal(|ui| { ui.label(RichText::new("+").size(22.0).color(Color32::from_rgb(132, 147, 255))); let response = ui.add(egui::TextEdit::singleline(&mut self.message_input).hint_text("Написать сообщение...").desired_width(f32::INFINITY)); if (response.lost_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter))) || ui.button("Отправить").clicked() { self.send_message(); } });
        });
    }
}

impl eframe::App for NativeClient {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let mut visuals = egui::Visuals::dark();
        visuals.window_corner_radius = egui::CornerRadius::same(14);
        visuals.window_fill = Color32::from_rgb(29, 36, 49);
        visuals.panel_fill = Color32::from_rgb(23, 29, 40);
        visuals.faint_bg_color = Color32::from_rgb(34, 42, 56);
        visuals.extreme_bg_color = Color32::from_rgb(15, 20, 28);
        ctx.set_visuals(visuals);
        ctx.style_mut(|style| {
            style.spacing.item_spacing = egui::vec2(8.0, 8.0);
            style.spacing.button_padding = egui::vec2(12.0, 8.0);
        });
        self.handle_task();
        if self.task.is_some() {
            ctx.request_repaint_after(std::time::Duration::from_millis(ASYNC_TASK_POLL_MS));
        }
        egui::CentralPanel::default().show(ctx, |ui| if self.session.is_some() { self.workspace_view(ui); } else { self.login_view(ui); });
    }
}

fn main() {
    let options = eframe::NativeOptions { viewport: egui::ViewportBuilder::default().with_inner_size([1280.0, 800.0]).with_min_inner_size([900.0, 600.0]), ..Default::default() };
    eframe::run_native("Discord Alt", options, Box::new(|_cc| Ok(Box::new(NativeClient::new())))).expect("failed to start native client");
}
