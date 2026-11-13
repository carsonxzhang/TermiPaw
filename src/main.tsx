import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// 不使用 StrictMode：其开发期的双重挂载会让每个标签建立两次 SSH 连接
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
