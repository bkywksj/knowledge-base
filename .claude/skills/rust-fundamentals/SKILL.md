---
name: rust-fundamentals
description: |
  Rust 语言基础技能,覆盖 Tauri 开发中常用的 Rust 核心概念。

  触发场景:
  - 遇到 Rust 编译错误(所有权/借用/生命周期)
  - 需要理解 Rust 语法和概念
  - 需要编写 Rust 数据结构和函数
  - 需要使用 Rust 异步编程

  触发词: Rust、所有权、借用、生命周期、编译错误、borrow、move、lifetime、async、trait
---

# Rust 基础(Tauri 开发必备)

## 核心概念速查

### 所有权规则

```rust
// 1. 每个值有且仅有一个所有者
let s1 = String::from("hello");
let s2 = s1;  // s1 的所有权转移(move)给 s2
// println!("{}", s1);  // ❌ s1 不再有效

// 2. 克隆(显式复制)
let s1 = String::from("hello");
let s2 = s1.clone();  // 深拷贝
println!("{} {}", s1, s2);  // ✅ 都有效

// 3. Copy 类型(栈上数据自动复制)
let x = 5;
let y = x;  // i32 实现了 Copy
println!("{} {}", x, y);  // ✅ 都有效
```

### 引用与借用

```rust
// 不可变引用(多个可以同时存在)
fn print_length(s: &str) {
    println!("长度: {}", s.len());
}

// 可变引用(同一时刻只能有一个)
fn append(s: &mut String) {
    s.push_str(" world");
}

let mut s = String::from("hello");
print_length(&s);      // 不可变借用
append(&mut s);         // 可变借用
```

### 在 Tauri Command 中的应用

```rust
// ✅ 参数用引用(不转移所有权)
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

// ✅ 返回新值(所有权转移给调用者)
#[tauri::command]
fn create_greeting(name: String) -> String {
    format!("Hello, {}!", name)
}
```

---

## 常用类型

### Option 和 Result

```rust
// Option: 可能为空的值
fn find_user(id: u32) -> Option<User> {
    if id == 1 { Some(User { name: "Alice".into() }) }
    else { None }
}

// 使用 Option
match find_user(1) {
    Some(user) => println!("{}", user.name),
    None => println!("未找到"),
}

// 简写
let name = find_user(1).map(|u| u.name).unwrap_or("未知".into());

// Result: 可能失败的操作
fn parse_number(s: &str) -> Result<i32, String> {
    s.parse::<i32>().map_err(|e| e.to_string())
}

// 使用 ? 传播错误
fn process(input: &str) -> Result<i32, String> {
    let num = parse_number(input)?;  // 失败则提前返回 Err
    Ok(num * 2)
}
```

---

## 结构体和枚举

```rust
use serde::{Serialize, Deserialize};

// 结构体(Tauri Command 数据传输)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct User {
    id: u32,
    name: String,
    email: Option<String>,
}

// 枚举
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Active,
    Inactive,
    Pending,
}

// impl 块(方法)
impl User {
    fn new(id: u32, name: String) -> Self {
        Self { id, name, email: None }
    }

    fn display_name(&self) -> &str {
        &self.name
    }
}
```

---

## 异步编程

```rust
// 异步函数
async fn fetch_data(url: &str) -> Result<String, String> {
    reqwest::get(url)
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())
}

// 异步 Tauri Command
#[tauri::command]
async fn async_operation() -> Result<String, String> {
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    Ok("完成".into())
}

// 并发执行
#[tauri::command]
async fn parallel_fetch() -> Result<Vec<String>, String> {
    let (r1, r2) = tokio::join!(
        fetch_data("https://api1.example.com"),
        fetch_data("https://api2.example.com"),
    );
    Ok(vec![r1?, r2?])
}
```

---

## 线程安全与 Mutex

```rust
use std::sync::Mutex;

// Tauri State 需要 Send + Sync
struct AppState {
    counter: Mutex<u32>,         // Mutex 确保线程安全
    items: Mutex<Vec<String>>,
}

#[tauri::command]
fn increment(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let mut counter = state.counter.lock().map_err(|e| e.to_string())?;
    *counter += 1;
    Ok(*counter)
}
```

---

## 常见编译错误速查

| 错误信息 | 原因 | 解决方法 |
|---------|------|---------|
| `value moved here` | 所有权已转移 | 使用 `clone()` 或引用 `&` |
| `cannot borrow as mutable` | 不可变引用存在时不能可变借用 | 调整借用顺序 |
| `lifetime may not live long enough` | 引用的生命周期不足 | 添加生命周期标注或 clone |
| `the trait bound is not satisfied` | 类型未实现所需 trait | 添加 derive 宏或手动实现 |
| `cannot move out of borrowed content` | 试图从引用中移出所有权 | 使用 `.clone()` 或 `.to_owned()` |

---

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 到处 `clone()` 解决编译错误 | 先理解所有权,必要时才 clone |
| `unwrap()` 处理 Result | 使用 `?` 或 `map_err` |
| 不用 Mutex 包裹共享状态 | Tauri State 中的可变数据必须 Mutex |
| 忽略 Rust 编译器建议 | 编译器建议通常是正确的 |
