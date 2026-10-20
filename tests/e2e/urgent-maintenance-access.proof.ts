import {expect,test} from '@playwright/test'
const fixture=`http://127.0.0.1:${4191+Number(process.env.PLAYWRIGHT_PORT_OFFSET??0)}/tests/fixtures/urgent-maintenance-ui.html`
for(const surface of ['my-time','requests']){
  test(`${surface}: employee urgent absence remains usable during full read-only maintenance`,async({page})=>{
    const submitted:Array<Record<string,unknown>>=[]
    await page.route('**/api/v1/time/attendance/report',async route=>{
      const body=route.request().postDataJSON() as Record<string,unknown>
      submitted.push(body)
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
        id:'30000000-0000-4000-8000-000000000001',callOffId:'40000000-0000-4000-8000-000000000001',employeeId:'10000000-0000-4000-8000-000000000001',employeeName:'Test Employee',username:'testemployee',eventType:body.eventType,status:'reported',operationalDate:body.operationalDate??'2026-09-07',shiftId:body.shiftId??null,startsAt:null,endsAt:null,timeZone:'America/Denver',siteName:null,siteCode:null,postName:null,eventName:null,locationName:'Test site',note:body.note,createdAt:'2026-09-06T16:00:00Z',created:true,alreadyRecorded:false,dispatchNotified:true,dispatchError:null,
      })})
    })
    await page.goto(`${fixture}?surface=${surface}&scenario=ready`)
    await expect(page.getByRole('status',{name:'SygShift maintenance notice'})).toContainText('Full database maintenance is in progress')
    if(surface==='my-time'){
      await expect(page.getByRole('button',{name:'Report sick / call-off'})).toBeEnabled()
      await page.getByRole('button',{name:'Report sick / call-off'}).click()
      const dialog=page.getByRole('dialog',{name:'Report sick or call-off'})
      await expect(dialog.getByRole('radio',{name:/Called in sick/})).toBeEnabled()
      await expect(dialog.getByRole('radio',{name:/Call-off \/ cannot work/})).toBeEnabled()
      await dialog.getByLabel(/Short note/).fill('Isolated browser illness report')
      await expect(dialog.getByRole('button',{name:'Send to Dispatch'})).toBeEnabled()
      await dialog.getByRole('button',{name:'Send to Dispatch'}).click()
      await expect(page.getByText('Attendance report saved')).toBeVisible()
      expect(submitted).toHaveLength(1)
      expect(submitted[0].eventType).toBe('called_in_sick')
    }else{
      await expect(page.getByRole('button',{name:'Review call-off'})).toBeEnabled()
      await page.getByRole('combobox',{name:'Assigned shift'}).selectOption('20000000-0000-4000-8000-000000000001')
      await page.getByRole('textbox',{name:'Reason',exact:true}).fill('Isolated browser urgent call-off')
      await page.getByRole('button',{name:'Review call-off'}).click()
      await expect(page.getByRole('button',{name:'Confirm call-off'})).toBeEnabled()
      await page.getByRole('button',{name:'Confirm call-off'}).click()
      await expect(page.getByRole('dialog',{name:'Confirm this call-off'})).toHaveCount(0)
      expect(submitted).toHaveLength(1)
      expect(submitted[0].eventType).toBe('call_off')
      await expect(page.getByRole('button',{name:'Review coverage'})).toHaveCount(0)
    }
  })
}
