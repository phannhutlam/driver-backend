// server.js
// --- 1. IMPORT CÁC THƯ VIỆN CẦN THIẾT ---
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

// --- 2. KHỞI TẠO SERVER & CẤU HÌNH ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const port = process.env.PORT || 3000;

// --- 3. CẤU HÌNH MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..')));

app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'cms', 'user-login.html'));
});

// --- 4. KẾT NỐI DATABASE & CẤU HÌNH CLOUDINARY ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('✅ Đã kết nối thành công tới MongoDB Atlas!');
        listenForDBChanges();
    })
    .catch(err => console.error('🔴 Lỗi kết nối MongoDB:', err));

// --- 5. SCHEMA DỮ LIỆU ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

const employeeSchema = new mongoose.Schema({
    name: { type: String, required: true, maxlength: 100 },
    department: { type: String, required: true, maxlength: 100 },
}, { timestamps: true });
const Employee = mongoose.model('Employee', employeeSchema);

const supplierSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true, maxlength: 150 },
}, { timestamps: true });
const Supplier = mongoose.model('Supplier', supplierSchema);

const vehicleSchema = new mongoose.Schema({
    licensePlate: { type: String, required: true, unique: true, maxlength: 15 },
    driverName: { type: String, maxlength: 50 },
    driverIdCard: { type: String, unique: true, sparse: true, maxlength: 12 },
    vehicleType: { type: String, maxlength: 50 },
    lastRegistered: { type: Date, default: Date.now }
}, { timestamps: true });
const Vehicle = mongoose.model('Vehicle', vehicleSchema);

const registrationSchema = new mongoose.Schema({
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    reason: { type: String, required: true, maxlength: 200 },
    priority: { type: String, required: true, enum: ['Thấp', 'Trung bình', 'Cao'], default: 'Trung bình' },
    expectedDate: { type: Date, required: true },
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    status: { type: String, enum: ['Chờ khai báo', 'Đã khai báo', 'Đã vào cổng', 'Đã rời cổng'], default: 'Chờ khai báo' },
    imageUrls: { idCardPhoto: String, licensePlatePhoto: String, vehiclePhoto: String },
    checkInTime: Date,
    checkOutTime: Date,
}, { timestamps: true });
const Registration = mongoose.model('Registration', registrationSchema);

// --- 6. MIDDLEWARE XÁC THỰC & PHÂN QUYỀN ---
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Không có token, xác thực thất bại.' });

    jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, user) => {
        if (err) return res.status(403).json({ message: 'Token không hợp lệ.' });
        req.user = user;
        next();
    });
};

const verifyAdmin = (req, res, next) => {
    verifyToken(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Yêu cầu quyền Admin.' });
        }
        next();
    });
};

// --- 7. LOGIC REAL-TIME (WEBSOCKET) ---
const broadcastUpdate = () => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update' }));
        }
    });
};

function listenForDBChanges() {
    const changeStream = Registration.watch([], { fullDocument: 'updateLookup' });
    changeStream.on('change', () => {
        console.log('Database changed, sending update signal.');
        broadcastUpdate();
    });
    console.log('👂 Đang lắng nghe các thay đổi từ database...');
}

wss.on('connection', ws => console.log('ℹ️ Một client đã kết nối WebSocket.'));

// --- 8. CÁC API ENDPOINTS ---

// A. API Xác thực
app.post('/api/auth/login', async (req, res, next) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
        }
        const token = jwt.sign({ id: user._id, role: user.role, username: user.username }, process.env.JWT_SECRET || 'secret', { expiresIn: '8h' });
        res.status(200).json({ token, role: user.role, username: user.username });
    } catch (error) {
        next(error);
    }
});

// B. API Quản lý (Admin)
const adminRouter = express.Router();
adminRouter.use(verifyAdmin);

adminRouter.get('/users', async (req, res, next) => {
    try {
        const users = await User.find({}, '-password');
        res.json(users);
    } catch (error) {
        next(error);
    }
});

adminRouter.post('/users', async (req, res, next) => {
    try {
        const { username, password, role } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword, role });
        await newUser.save();
        res.status(201).json({ message: 'Tạo người dùng thành công.' });
    } catch (error) {
        next(error);
    }
});

adminRouter.put('/users/:id', async (req, res, next) => {
    try {
        const { role } = req.body;
        await User.findByIdAndUpdate(req.params.id, { role });
        res.json({ message: 'Cập nhật vai trò thành công.' });
    } catch (error) {
        next(error);
    }
});

adminRouter.put('/users/:id/reset-password', async (req, res, next) => {
    try {
        const { newPassword } = req.body;
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await User.findByIdAndUpdate(req.params.id, { password: hashedPassword });
        res.json({ message: 'Đặt lại mật khẩu thành công.' });
    } catch (error) {
        next(error);
    }
});

adminRouter.delete('/users/:id', async (req, res, next) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'Xóa người dùng thành công.' });
    } catch (error) {
        next(error);
    }
});
app.use('/api/admin', adminRouter);

// C. API Nghiệp vụ
app.post('/api/requests', async (req, res, next) => {
    try {
        const { employeeName, employeeDepartment, supplierName, expectedDate, reason, priority } = req.body;
        if (!employeeName || !employeeDepartment || !supplierName || !expectedDate || !reason || !priority) {
            return res.status(400).json({ message: 'Vui lòng điền đầy đủ tất cả thông tin.' });
        }
        const employee = await Employee.findOneAndUpdate({ name: employeeName, department: employeeDepartment }, { $set: { name: employeeName, department: employeeDepartment } }, { upsert: true, new: true });
        const supplier = await Supplier.findOneAndUpdate({ name: supplierName }, { $set: { name: supplierName } }, { upsert: true, new: true });
        const newRequest = new Registration({ employee: employee._id, supplier: supplier._id, expectedDate, reason, priority });
        await newRequest.save();
        res.status(201).json({ message: 'Tạo yêu cầu thành công!', id: newRequest._id });
    } catch (error) {
        next(error);
    }
});

app.get('/api/requests/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'ID không hợp lệ.' });
        const request = await Registration.findById(id).populate('employee').populate('supplier');
        if (!request) return res.status(404).json({ message: 'Không tìm thấy yêu cầu.' });
        res.status(200).json({
            employeeName: request.employee ? request.employee.name : 'Không rõ',
            department: request.employee ? request.employee.department : 'Không rõ',
            expectedDate: request.expectedDate,
            supplierName: request.supplier ? request.supplier.name : 'Không rõ',
            reason: request.reason,
        });
    } catch (error) {
        next(error);
    }
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
app.put('/api/declarations/:id', upload.fields([
    { name: 'idCardPhoto', maxCount: 1 }, { name: 'licensePlatePhoto', maxCount: 1 }, { name: 'vehiclePhoto', maxCount: 1 }
]), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { driverName, driverIdCard, licensePlate, vehicleType } = req.body;
        const files = req.files;

        if (!files || !files.idCardPhoto || !files.licensePlatePhoto || !files.vehiclePhoto) {
            return res.status(400).json({ message: 'Vui lòng tải lên đủ 3 hình ảnh: CCCD, Biển số, và Toàn cảnh xe.' });
        }

        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'ID không hợp lệ.' });

        const normalizedLicensePlate = licensePlate.toUpperCase().replace(/[^A-Z0-9]/g, '');
        let vehicle = await Vehicle.findOneAndUpdate(
            { licensePlate: normalizedLicensePlate },
            { driverName, driverIdCard, vehicleType, lastRegistered: new Date() },
            { new: true, upsert: true }
        );

        const uploadToCloudinary = (file) => new Promise((resolve, reject) => {
            if (!process.env.CLOUDINARY_CLOUD_NAME) {
                return reject(new Error("Chưa cấu hình Cloudinary."));
            }
            const stream = cloudinary.uploader.upload_stream({ folder: "driver_registrations" }, (err, result) => err ? reject(err) : resolve(result.secure_url));
            stream.end(file.buffer);
        });

        const [idCardUrl, licensePlateUrl, vehicleUrl] = await Promise.all([
            uploadToCloudinary(files.idCardPhoto[0]),
            uploadToCloudinary(files.licensePlatePhoto[0]),
            uploadToCloudinary(files.vehiclePhoto[0])
        ]);

        const updatedDeclaration = await Registration.findByIdAndUpdate(id, {
            status: 'Đã khai báo',
            imageUrls: { idCardPhoto: idCardUrl, licensePlatePhoto: licensePlateUrl, vehiclePhoto: vehicleUrl },
            vehicle: vehicle._id
        }, { new: true });

        if (!updatedDeclaration) return res.status(404).json({ message: 'Không tìm thấy yêu cầu.' });
        res.status(200).json({ message: 'Khai báo thành công!' });
    } catch (error) {
        next(error);
    }
});

app.get('/api/registrations', verifyToken, async (req, res, next) => {
    try {
        const registrations = await Registration.find({})
            .populate('employee', 'name department')
            .populate('supplier', 'name')
            .populate('vehicle', 'licensePlate driverName driverIdCard vehicleType')
            .sort({ createdAt: -1 });
        res.status(200).json(registrations);
    } catch (error) {
        next(error);
    }
});

const handleCheckAction = async (req, res, action) => {
    try {
        const { id } = req.params;
        const update = action === 'checkin'
            ? { status: 'Đã vào cổng', checkInTime: new Date() }
            : { status: 'Đã rời cổng', checkOutTime: new Date() };
        await Registration.findByIdAndUpdate(id, update);
        broadcastUpdate();
        res.status(200).json({ message: 'Cập nhật thành công' });
    } catch (error) {
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ.' });
    }
};

app.post('/api/registrations/:id/checkin', verifyToken, (req, res) => handleCheckAction(req, res, 'checkin'));
app.post('/api/registrations/:id/checkout', verifyToken, (req, res) => handleCheckAction(req, res, 'checkout'));

// *** FIX: Thay đổi middleware từ verifyAdmin sang verifyToken ***
app.get('/api/registrations/history', verifyToken, async (req, res, next) => {
    try {
        const { start, end, q } = req.query;
        if (!start || !end) return res.status(400).json({ message: 'Ngày bắt đầu và kết thúc là bắt buộc.' });
        
        const startDate = new Date(start);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(end);
        endDate.setHours(23, 59, 59, 999);
        
        const query = { createdAt: { $gte: startDate, $lte: endDate } };

        if (q) {
            const regex = new RegExp(q, 'i');
            const employees = await Employee.find({ name: regex }).select('_id');
            const suppliers = await Supplier.find({ name: regex }).select('_id');
            const vehicles = await Vehicle.find({ $or: [{ licensePlate: regex }, { driverName: regex }] }).select('_id');
            query.$or = [
                { reason: regex },
                { employee: { $in: employees.map(e => e._id) } },
                { supplier: { $in: suppliers.map(s => s._id) } },
                { vehicle: { $in: vehicles.map(v => v._id) } },
            ];
        }

        const historyLogs = await Registration.find(query)
            .populate('employee', 'name department')
            .populate('supplier', 'name')
            .populate('vehicle', 'licensePlate driverName vehicleType')
            .sort({ createdAt: -1 });
        res.status(200).json(historyLogs);
    } catch (error) {
        next(error);
    }
});

// --- 9. MIDDLEWARE XỬ LÝ LỖI ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    if (err.code === 11000) {
        return res.status(409).json({ message: 'Dữ liệu bị trùng lặp. Vui lòng kiểm tra lại.' });
    }
    res.status(500).json({ message: err.message || 'Lỗi máy chủ nội bộ. Vui lòng thử lại sau.' });
});

// --- 10. KHỞI ĐỘNG SERVER ---
server.listen(port, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${port}`);
});
