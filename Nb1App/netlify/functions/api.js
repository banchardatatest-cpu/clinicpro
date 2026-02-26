const { neon } = require('@neondatabase/serverless');
const { google } = require('googleapis');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method Not Allowed' }) };

    const dbUrl = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!dbUrl) return { statusCode: 500, body: JSON.stringify({ success: false, message: 'Database URL is missing' }) };
    const sql = neon(dbUrl);

    try {
        const body = JSON.parse(event.body);
        const { action, payload } = body;

        const logAudit = async (actionName, tableName, recordId, details) => {
            if (!payload.currentUserId) return;
            try { await sql`INSERT INTO audit_logs (user_id, action, table_name, record_id, new_data) VALUES (${payload.currentUserId}, ${actionName}, ${tableName}, ${recordId || null}, ${JSON.stringify(details)})`; } 
            catch(e) { console.error('Audit Log Error:', e); }
        };

        // ==========================================
        // 1. AUTH & STAFF
        // ==========================================
        if (action === 'login') {
            const users = await sql`SELECT id, username, display_name, role, avatar_url FROM users WHERE username = ${payload.username} AND pin_code = ${payload.pin}`;
            if (users.length > 0) return { statusCode: 200, body: JSON.stringify({ success: true, user: users[0] }) };
            return { statusCode: 401, body: JSON.stringify({ success: false, message: 'ข้อมูลไม่ถูกต้อง' }) };
        }
        if (action === 'get_staff') {
            let staff;
            if (payload.currentUserRole === 'Super Owner') {
                staff = await sql`SELECT id, username, pin_code, display_name, role, avatar_url FROM users ORDER BY role, display_name`;
            } else {
                staff = await sql`SELECT id, username, pin_code, display_name, role, avatar_url FROM users WHERE role != 'Super Owner' ORDER BY role, display_name`;
            }
            return { statusCode: 200, body: JSON.stringify({ success: true, staff }) };
        }
        if (action === 'update_own_avatar') {
            await sql`UPDATE users SET avatar_url = ${payload.avatar_url} WHERE id = ${payload.currentUserId}`;
            await logAudit('UPDATE_AVATAR', 'users', payload.currentUserId, { updated: 'avatar' });
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 2. CATALOG & TIERS 
        // ==========================================
        if (action === 'get_catalog') {
            const categories = await sql`SELECT * FROM product_categories ORDER BY id ASC`;
            const products = await sql`SELECT * FROM products ORDER BY category_id, product_name ASC`;
            const tiers = await sql`SELECT * FROM commission_tiers ORDER BY min_sales ASC`;
            return { statusCode: 200, body: JSON.stringify({ success: true, categories, products, tiers }) };
        }
        
        if (action === 'manage_catalog') {
            if (payload.type === 'category') {
                const pct = (payload.percent === '' || payload.percent == null) ? 0 : payload.percent;
                if (payload.subAction === 'edit') await sql`UPDATE product_categories SET category_name=${payload.name}, deduct_cost_percent=${pct} WHERE id=${payload.id}`;
                else if (payload.subAction === 'delete') await sql`DELETE FROM product_categories WHERE id=${payload.id}`;
                else await sql`INSERT INTO product_categories (category_name, deduct_cost_percent) VALUES (${payload.name}, ${pct})`;
            } else if (payload.type === 'product') {
                const btFee = (payload.bt_fee === '' || payload.bt_fee == null) ? 0 : payload.bt_fee;
                if (payload.subAction === 'edit') await sql`UPDATE products SET category_id=${payload.categoryId}, product_name=${payload.name}, unit_name=${payload.unit}, bt_fee=${btFee} WHERE id=${payload.id}`;
                else if (payload.subAction === 'delete') await sql`DELETE FROM products WHERE id=${payload.id}`;
                else await sql`INSERT INTO products (category_id, product_name, unit_name, bt_fee) VALUES (${payload.categoryId}, ${payload.name}, ${payload.unit}, ${btFee})`;
            } else if (payload.type === 'tier') {
                const minSales = (payload.min === '' || payload.min == null) ? 0 : payload.min;
                const maxSales = (payload.max === '' || payload.max == null) ? null : payload.max;
                const pct = (payload.percent === '' || payload.percent == null) ? 0 : payload.percent;
                if (payload.subAction === 'edit') await sql`UPDATE commission_tiers SET min_sales=${minSales}, max_sales=${maxSales}, commission_percent=${pct} WHERE id=${payload.id}`;
                else if (payload.subAction === 'delete') await sql`DELETE FROM commission_tiers WHERE id=${payload.id}`;
                else await sql`INSERT INTO commission_tiers (min_sales, max_sales, commission_percent) VALUES (${minSales}, ${maxSales}, ${pct})`;
            }
            await logAudit(`MANAGE_${payload.type.toUpperCase()}`, 'catalog', payload.id, { subAction: payload.subAction, name: payload.name });
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 3. ORDERS & PAYMENTS (Telegram + Image Send)
        // ==========================================
        if (action === 'save_order') {
            let customerId;
            const existing = await sql`SELECT id FROM customers WHERE phone = ${payload.phone}`;
            if (existing.length > 0) {
                customerId = existing[0].id;
                await sql`UPDATE customers SET first_name=${payload.firstName}, last_name=${payload.lastName}, emergency_phone=${payload.emergencyPhone||null}, line_id=${payload.lineId||null}, facebook=${payload.facebook||null}, age=${payload.age||null}, weight=${payload.weight||null}, height=${payload.height||null}, disease=${payload.disease||null}, drug_allergy=${payload.drugAllergy||null}, occupation=${payload.occupation||null}, workplace=${payload.workplace||null}, address=${payload.address||null}, pdpa_consent=${payload.pdpa} WHERE id=${customerId}`;
            } else {
                const newC = await sql`INSERT INTO customers (first_name, last_name, phone, emergency_phone, line_id, facebook, age, weight, height, disease, drug_allergy, occupation, workplace, address, pdpa_consent) VALUES (${payload.firstName}, ${payload.lastName}, ${payload.phone}, ${payload.emergencyPhone||null}, ${payload.lineId||null}, ${payload.facebook||null}, ${payload.age||null}, ${payload.weight||null}, ${payload.height||null}, ${payload.disease||null}, ${payload.drugAllergy||null}, ${payload.occupation||null}, ${payload.workplace||null}, ${payload.address||null}, ${payload.pdpa}) RETURNING id`;
                customerId = newC[0].id;
            }

            let targetOrderId = payload.existingOrderId;
            let isNewOrder = false;

            if (!targetOrderId && payload.items && payload.items.length > 0) {
                const itemsJson = JSON.stringify(payload.items); 
                const newOrder = await sql`INSERT INTO orders (customer_id, sale_staff_id, items, total_price, image_url, status, approval_status) VALUES (${customerId}, ${payload.saleStaffId}, ${itemsJson}, ${payload.totalPrice}, ${payload.imageUrl}, 'Active', 'Pending') RETURNING id`;
                targetOrderId = newOrder[0].id;
                isNewOrder = true;
            }

            if (targetOrderId && payload.paymentAmount > 0) {
                const pType = payload.existingOrderId ? 'Old Debt' : 'New Order';
                await sql`INSERT INTO payments (order_id, amount, payment_method, receiver_id, image_url, payment_type, approval_status) VALUES (${targetOrderId}, ${payload.paymentAmount}, ${payload.paymentMethod}, ${payload.currentUserId}, ${payload.imageUrl}, ${pType}, 'Pending')`;
            }

            if (targetOrderId && payload.usageDetails) {
                await sql`INSERT INTO service_usage (order_id, customer_id, usage_date, details, dr_id, bt_id, created_by) VALUES (${targetOrderId}, ${customerId}, CURRENT_DATE, ${payload.usageDetails}, ${payload.drId||null}, ${payload.btId||null}, ${payload.currentUserId})`;
            }

            await logAudit('SAVE_ORDER', 'orders', targetOrderId, { totalPrice: payload.totalPrice, paymentAmount: payload.paymentAmount });

            // Telegram Alert Logic (อัปเกรดส่งรูปภาพ)
            try {
                const settings = await sql`SELECT * FROM system_settings LIMIT 1`;
                if (settings.length > 0 && settings[0].tg_token && settings[0].tg_config) {
                    const tgConfig = typeof settings[0].tg_config === 'string' ? JSON.parse(settings[0].tg_config) : settings[0].tg_config;
                    let itemsTxt = '';
                    if (payload.items && payload.items.length > 0) { payload.items.forEach(i => { itemsTxt += `- ${i.name} ${i.qty||1} ${i.unit||''} = ${(parseFloat(i.total)||0).toLocaleString()}฿\n`; }); }
                    const balance = parseFloat(payload.totalPrice) - parseFloat(payload.paymentAmount);

                    // ฟังก์ชันสำหรับยิง Telegram API (รองรับรูปภาพ)
                    const sendToTelegram = async (textMessage) => {
                        let tgUrl = `https://api.telegram.org/bot${settings[0].tg_token}/sendMessage`;
                        let tgBody = { chat_id: settings[0].tg_chat_id, text: textMessage, parse_mode: 'HTML' };
                        
                        // ถ้ามีการแนบรูปมาด้วย ให้เปลี่ยนไปใช้ sendPhoto
                        if (payload.imageUrl && payload.imageUrl.startsWith('http')) {
                            tgUrl = `https://api.telegram.org/bot${settings[0].tg_token}/sendPhoto`;
                            tgBody = { chat_id: settings[0].tg_chat_id, photo: payload.imageUrl, caption: textMessage, parse_mode: 'HTML' };
                        }
                        
                        await fetch(tgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tgBody) });
                    };

                    if (isNewOrder && tgConfig.events?.new_order) {
                        let txt = `🚨 <b>แจ้งทำรายการออเดอร์ใหม่ (รออนุมัติ)</b>\n`;
                        if (tgConfig.fields?.date) txt += `📅 วันที่: ${new Date().toLocaleDateString('th-TH')}\n`;
                        if (tgConfig.fields?.name) txt += `👤 ลูกค้า: ${payload.firstName} ${payload.lastName}\n`;
                        if (tgConfig.fields?.items && itemsTxt) txt += `📦 รายการสินค้า:\n${itemsTxt}`;
                        if (tgConfig.fields?.price) txt += `🔖 ราคารวม: ${parseFloat(payload.totalPrice).toLocaleString()} ฿\n`;
                        if (tgConfig.fields?.amount) txt += `💰 ยอดชำระเข้า: ${parseFloat(payload.paymentAmount).toLocaleString()} ฿\n`;
                        if (tgConfig.fields?.balance) txt += `📉 ยอดค้าง: ${balance > 0 ? balance.toLocaleString() : 0} ฿\n`;
                        if (tgConfig.fields?.staff) txt += `👩‍💼 พนักงาน: ${payload.saleStaffName}\n`;
                        await sendToTelegram(txt);
                    }
                    else if (!isNewOrder && payload.paymentAmount > 0 && tgConfig.events?.payment) {
                        let txt = `💸 <b>แจ้งรับชำระเงิน (บิลเก่า/รออนุมัติ)</b>\n`;
                        if (tgConfig.fields?.date) txt += `📅 วันที่: ${new Date().toLocaleDateString('th-TH')}\n`;
                        if (tgConfig.fields?.name) txt += `👤 ลูกค้า: ${payload.firstName} ${payload.lastName}\n`;
                        if (tgConfig.fields?.amount) txt += `💰 ยอดชำระเข้า: ${parseFloat(payload.paymentAmount).toLocaleString()} ฿\n`;
                        if (tgConfig.fields?.staff) txt += `👩‍💼 พนักงานรับชำระ: ${payload.saleStaffName}\n`;
                        await sendToTelegram(txt);
                    }

                    if (payload.usageDetails && !isNewOrder && tgConfig.events?.usage) {
                        let txt = `💆‍♀️ <b>บันทึกการเข้าใช้บริการ</b>\n👤 ลูกค้า: ${payload.firstName}\n📝 ทำรายการ: ${payload.usageDetails}`;
                        let tgUrl = `https://api.telegram.org/bot${settings[0].tg_token}/sendMessage`;
                        await fetch(tgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: settings[0].tg_chat_id, text: txt, parse_mode: 'HTML' }) });
                    }
                }
            } catch (e) { console.log('TG Error', e); }

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 4. FINANCE APPROVAL
        // ==========================================
        if (action === 'get_approvals') {
            let query;
            if (payload.status === 'pending') {
                query = await sql`SELECT p.id, p.amount, p.payment_method, p.created_at, p.approval_status, o.id as order_id, o.total_price, o.items, o.status as order_status, c.first_name, c.last_name, c.phone, u.display_name as sale_name, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE order_id = o.id AND approval_status = 'Approved') as total_paid FROM payments p JOIN orders o ON p.order_id = o.id JOIN customers c ON o.customer_id = c.id LEFT JOIN users u ON o.sale_staff_id = u.id WHERE p.approval_status = 'Pending' ORDER BY p.created_at ASC`;
            } else {
                query = await sql`SELECT p.id, p.amount, p.payment_method, p.created_at, p.approval_status, p.approval_updated_at, o.id as order_id, o.total_price, o.items, o.status as order_status, c.first_name, c.last_name, c.phone, u.display_name as sale_name, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE order_id = o.id AND approval_status = 'Approved') as total_paid FROM payments p JOIN orders o ON p.order_id = o.id JOIN customers c ON o.customer_id = c.id LEFT JOIN users u ON o.sale_staff_id = u.id WHERE p.approval_status IN ('Approved', 'Rejected') ORDER BY p.approval_updated_at DESC LIMIT 50`;
            }
            return { statusCode: 200, body: JSON.stringify({ success: true, list: query }) };
        }

        if (action === 'set_approval') {
            await sql`UPDATE payments SET approval_status = ${payload.status}, approval_updated_at = CURRENT_TIMESTAMP WHERE id = ${payload.paymentId}`;
            if(payload.status === 'Approved') await sql`UPDATE orders SET approval_status = 'Approved' WHERE id = ${payload.orderId}`;
            await logAudit('FINANCE_APPROVAL', 'payments', payload.paymentId, { status: payload.status });
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 5. SUMMARY & COMMISSION
        // ==========================================
        if (action === 'get_sales_summary') {
            const startDate = `${payload.startDate} 00:00:00`; 
            const endDate = `${payload.endDate} 23:59:59`;

            const settings = await sql`SELECT cc_fee_percent, shop_commission_percent FROM system_settings LIMIT 1`;
            const ccFeePercent = settings.length > 0 ? parseFloat(settings[0].cc_fee_percent || 0) : 0;
            const shopCommPct = settings.length > 0 ? parseFloat(settings[0].shop_commission_percent || 0) : 0;

            const orders = await sql`SELECT id, sale_staff_id, items, total_price FROM orders WHERE status != 'Cancelled' AND approval_status = 'Approved' AND created_at >= ${startDate}::timestamp AND created_at <= ${endDate}::timestamp`;
            const payments = await sql`SELECT p.order_id, p.amount, p.payment_method FROM payments p JOIN orders o ON p.order_id = o.id WHERE p.approval_status = 'Approved' AND p.created_at >= ${startDate}::timestamp AND p.created_at <= ${endDate}::timestamp`;
            const deductions = await sql`SELECT p.order_id, p.amount, p.payment_method, o.sale_staff_id FROM payments p JOIN orders o ON p.order_id = o.id WHERE p.approval_status = 'Rejected' AND p.approval_updated_at >= ${startDate}::timestamp AND p.approval_updated_at <= ${endDate}::timestamp AND p.created_at < ${startDate}::timestamp`;
            const usages = await sql`SELECT su.bt_id, o.items FROM service_usage su JOIN orders o ON su.order_id = o.id WHERE su.usage_date >= ${startDate}::date AND su.usage_date <= ${endDate}::date`;
            const tiers = await sql`SELECT * FROM commission_tiers ORDER BY min_sales ASC`;
            const staffList = await sql`SELECT id, display_name FROM users`;

            let staffPerfMap = {}; let shopTotalSales = 0; let shopTotalCollected = 0; let shopTotalNet = 0; let orderCostPctMap = {};

            orders.forEach(o => {
                const staffId = o.sale_staff_id;
                if (!staffPerfMap[staffId]) staffPerfMap[staffId] = { id: staffId, name: staffList.find(s=>s.id===staffId)?.display_name || 'ไม่ระบุ', total_sales: 0, total_collected: 0, total_cost: 0, bt_fee_total: 0, order_count: 0 };
                let orderCost = 0; let tPrice = parseFloat(o.total_price) || 1;
                if (o.items && Array.isArray(o.items)) { o.items.forEach(item => { orderCost += ((parseFloat(item.total) || 0) * (parseFloat(item.deduct_percent) || 0) / 100); }); }
                orderCostPctMap[o.id] = (orderCost / tPrice);
                staffPerfMap[staffId].total_sales += parseFloat(o.total_price);
                staffPerfMap[staffId].order_count += 1;
                shopTotalSales += parseFloat(o.total_price);
            });

            payments.forEach(p => {
                const order = orders.find(o => o.id === p.order_id);
                if (order) {
                    let amount = parseFloat(p.amount); let ccFee = 0;
                    if (p.payment_method === 'บัตรเครดิต') { ccFee = amount * (ccFeePercent / 100); amount = amount - ccFee; }
                    let costPct = orderCostPctMap[p.order_id] || 0;
                    let costDeduction = parseFloat(p.amount) * costPct;
                    staffPerfMap[order.sale_staff_id].total_collected += amount;
                    staffPerfMap[order.sale_staff_id].total_cost += costDeduction;
                    shopTotalCollected += amount;
                }
            });

            deductions.forEach(d => {
                if (!staffPerfMap[d.sale_staff_id]) staffPerfMap[d.sale_staff_id] = { id: d.sale_staff_id, name: staffList.find(s=>s.id===d.sale_staff_id)?.display_name || 'ไม่ระบุ', total_sales: 0, total_collected: 0, total_cost: 0, bt_fee_total: 0, order_count: 0 };
                let amt = parseFloat(d.amount);
                if (d.payment_method === 'บัตรเครดิต') amt = amt - (amt * (ccFeePercent / 100));
                staffPerfMap[d.sale_staff_id].total_collected -= amt;
                shopTotalCollected -= amt;
            });

            usages.forEach(u => {
                if (u.bt_id) {
                    if (!staffPerfMap[u.bt_id]) staffPerfMap[u.bt_id] = { id: u.bt_id, name: staffList.find(s=>s.id===u.bt_id)?.display_name || 'ไม่ระบุ', total_sales: 0, total_collected: 0, total_cost: 0, bt_fee_total: 0, order_count: 0 };
                    let totalBtFee = 0;
                    if (u.items && Array.isArray(u.items)) { u.items.forEach(item => { totalBtFee += (parseFloat(item.bt_fee) || 0) * (parseFloat(item.qty) || 1); }); }
                    staffPerfMap[u.bt_id].bt_fee_total += totalBtFee;
                }
            });

            let staffPerfArray = Object.values(staffPerfMap).map(sp => {
                let netCollected = sp.total_collected - sp.total_cost; 
                if (netCollected < 0) netCollected = 0;
                shopTotalNet += netCollected;
                let matchedTier = tiers[0] || { commission_percent: 0 };
                for (let i = 0; i < tiers.length; i++) { if (sp.total_sales >= parseFloat(tiers[i].min_sales) && (!tiers[i].max_sales || sp.total_sales <= parseFloat(tiers[i].max_sales))) matchedTier = tiers[i]; }
                return { ...sp, net_collected: netCollected, commission_percent: parseFloat(matchedTier.commission_percent), commission_amount: netCollected * (parseFloat(matchedTier.commission_percent) / 100) };
            });

            if (['Sales', 'BT', 'Dr'].includes(payload.currentUserRole)) { staffPerfArray = staffPerfArray.filter(sp => sp.id === payload.currentUserId); }
            staffPerfArray.sort((a, b) => b.total_sales - a.total_sales);
            
            return { statusCode: 200, body: JSON.stringify({ success: true, staffPerf: staffPerfArray, shopSummary: { totalSales: shopTotalSales, totalCollected: shopTotalCollected, shopCommission: shopTotalNet * (shopCommPct / 100), shopCommPct: shopCommPct } })};
        }

        // ==========================================
        // 6. APPOINTMENTS & CUSTOMERS 
        // ==========================================
        if (action === 'get_appointments') {
            const appointments = await sql`SELECT a.id, a.appointment_date, a.appointment_time, a.service_details, a.status, c.first_name, c.last_name, c.phone, c.id as customer_id, u_dr.display_name as dr_name, u_bt.display_name as bt_name, a.dr_id, a.bt_id, a.created_by FROM appointments a JOIN customers c ON a.customer_id = c.id LEFT JOIN users u_dr ON a.dr_id = u_dr.id LEFT JOIN users u_bt ON a.bt_id = u_bt.id WHERE a.status != 'Cancelled' ORDER BY a.appointment_date ASC, a.appointment_time ASC LIMIT 100`;
            return { statusCode: 200, body: JSON.stringify({ success: true, appointments }) };
        }

        if (action === 'search_customers') {
            const q = payload.query || ''; let customers = [];
            if (['Sales', 'BT', 'Dr'].includes(payload.currentUserRole)) { customers = await sql`SELECT DISTINCT c.* FROM customers c LEFT JOIN orders o ON c.id = o.customer_id LEFT JOIN service_usage su ON c.id = su.customer_id WHERE (c.first_name ILIKE ${'%'+q+'%'} OR c.last_name ILIKE ${'%'+q+'%'} OR c.phone ILIKE ${'%'+q+'%'}) AND (o.sale_staff_id = ${payload.currentUserId} OR su.dr_id = ${payload.currentUserId} OR su.bt_id = ${payload.currentUserId}) ORDER BY c.first_name ASC LIMIT 50`; } 
            else { customers = await sql`SELECT * FROM customers WHERE first_name ILIKE ${'%'+q+'%'} OR last_name ILIKE ${'%'+q+'%'} OR phone ILIKE ${'%'+q+'%'} ORDER BY first_name ASC LIMIT 50`; }
            return { statusCode: 200, body: JSON.stringify({ success: true, customers }) };
        }

        if (action === 'get_customer_full_detail') {
            const cid = payload.customerId;
            const profile = await sql`SELECT * FROM customers WHERE id = ${cid}`;
            const orders = await sql`SELECT o.id, o.created_at, o.total_price, o.status, o.items, o.sale_staff_id, u.display_name as sale_name FROM orders o LEFT JOIN users u ON o.sale_staff_id = u.id WHERE o.customer_id = ${cid} ORDER BY o.created_at DESC`;
            const payments = await sql`SELECT p.id, p.order_id, p.amount, p.created_at, p.payment_method, p.payment_type FROM payments p JOIN orders o ON p.order_id = o.id WHERE o.customer_id = ${cid} AND p.approval_status = 'Approved' ORDER BY p.created_at DESC`;
            const usage = await sql`SELECT su.id, su.order_id, su.usage_date, su.details, dr.display_name as dr_name FROM service_usage su LEFT JOIN users dr ON su.dr_id = dr.id WHERE su.customer_id = ${cid} ORDER BY su.usage_date DESC`;
            const debt = await sql`SELECT (SELECT COALESCE(SUM(total_price), 0) FROM orders WHERE customer_id = ${cid} AND status != 'Cancelled' AND approval_status = 'Approved') as total_price, (SELECT COALESCE(SUM(amount), 0) FROM payments p JOIN orders o ON p.order_id = o.id WHERE o.customer_id = ${cid} AND p.approval_status = 'Approved') as total_paid`;
            return { statusCode: 200, body: JSON.stringify({ success: true, customer: profile[0], orders, payments, usage, total_debt: debt[0].total_price - debt[0].total_paid }) };
        }

        // ==========================================
        // 7. UTILS & SETTINGS
        // ==========================================
        if (action === 'get_settings') {
            const settings = await sql`SELECT * FROM system_settings ORDER BY id DESC LIMIT 1`;
            return { statusCode: 200, body: JSON.stringify({ success: true, settings: settings[0] }) };
        }
        if (action === 'save_settings') {
            const tgJson = JSON.stringify(payload.tg_config);
            await sql`UPDATE system_settings SET clinic_name=${payload.clinic_name}, ui_primary_color=${payload.ui_primary_color}, ui_bg_color=${payload.ui_bg_color}, ui_nav_bg=${payload.ui_nav_bg}, ui_nav_text=${payload.ui_nav_text}, ui_board_text=${payload.ui_board_text}, contact_info=${payload.contact_info}, logo_url=${payload.logo_url}, cc_fee_percent=${payload.cc_fee_percent}, tg_token=${payload.tg_token}, tg_chat_id=${payload.tg_chat_id}, tg_config=${tgJson}::jsonb, enable_sound=${payload.enable_sound}, success_msg=${payload.success_msg}, shop_commission_percent=${payload.shop_commission_percent}`;
            await logAudit('UPDATE_SETTINGS', 'system_settings', null, { details: 'System settings updated' });
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        
        if (action === 'test_telegram') {
            const txt = "✅ <b>ทดสอบระบบแจ้งเตือน Telegram สำเร็จ!</b>\nระบบ Clinic Manager Pro เชื่อมต่อเรียบร้อยแล้ว";
            const response = await fetch(`https://api.telegram.org/bot${payload.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: payload.chatId, text: txt, parse_mode: 'HTML' }) });
            if(response.ok) return { statusCode: 200, body: JSON.stringify({ success: true }) };
            return { statusCode: 400, body: JSON.stringify({ success: false, message: 'ส่งไม่สำเร็จ' }) };
        }

        if (action === 'manage_staff') {
            if (['edit', 'delete'].includes(payload.subAction)) {
                const target = await sql`SELECT role FROM users WHERE id = ${payload.id}`;
                if (target.length > 0 && ['Owner', 'Super Owner'].includes(target[0].role) && payload.currentUserRole !== 'Super Owner') return { statusCode: 403, body: JSON.stringify({ success: false, message: '🔒 เฉพาะระดับ Super Owner เท่านั้นที่จัดการสิทธิ์ Owner ได้' }) };
            }
            if (['add', 'edit'].includes(payload.subAction) && ['Owner', 'Super Owner'].includes(payload.role) && payload.currentUserRole !== 'Super Owner') {
                return { statusCode: 403, body: JSON.stringify({ success: false, message: '🔒 ไม่อนุญาตให้สร้างตำแหน่ง Owner' }) };
            }

            if (payload.subAction === 'delete') await sql`DELETE FROM users WHERE id = ${payload.id}`;
            else if (payload.subAction === 'edit') await sql`UPDATE users SET username=${payload.username}, pin_code=${payload.pin}, display_name=${payload.name}, role=${payload.role} WHERE id=${payload.id}`;
            else if (payload.subAction === 'add') await sql`INSERT INTO users (username, pin_code, display_name, role) VALUES (${payload.username}, ${payload.pin}, ${payload.name}, ${payload.role})`;
            
            await logAudit(`STAFF_${payload.subAction.toUpperCase()}`, 'users', payload.id || null, { targetRole: payload.role });
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (action === 'upload_image') {
            let credentials;
            if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) { credentials = { client_email: process.env.GOOGLE_CLIENT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') }; } 
            else if (process.env.GOOGLE_CREDENTIALS) { credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); } 
            else throw new Error("Missing GDrive Config");
            const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.file'] });
            const drive = google.drive({ version: 'v3', auth });
            const base64Data = payload.base64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const res = await drive.files.create({ requestBody: { name: payload.fileName, parents: [process.env.GDRIVE_FOLDER_ID] }, media: { mimeType: 'image/jpeg', body: require('stream').Readable.from(buffer) }, fields: 'id' });
            const directLink = `https://drive.google.com/uc?export=view&id=${res.data.id}`;
            return { statusCode: 200, body: JSON.stringify({ success: true, link: directLink }) };
        }

        return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid action' }) };
    } catch (err) { console.error(err); return { statusCode: 500, body: JSON.stringify({ success: false, message: err.message }) }; }
};
